#include "downloader.hpp"
#include <windows.h>
#include <wininet.h>
#include <iostream>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <algorithm>

#pragma comment(lib, "wininet.lib")

namespace DownloaderCore {

NativeDownloader::NativeDownloader(const std::string& url, const std::string& outputPath, size_t threadCount)
    : mediaUrl(url), outputFile(outputPath), numThreads(threadCount),
      fileSize(0), supportsRange(false), isRunning(false), isPaused(false),
      isComplete(false), totalDownloaded(0), speedLimitBytesPerSec(0) {
    stateFile = outputFile + ".ddl.json";
}

NativeDownloader::~NativeDownloader() {
    cancel();
}

bool NativeDownloader::queryFileInfo() {
    HINTERNET hInternet = InternetOpenA("DownloaderEngine/1.0", INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
    if (!hInternet) return false;

    HINTERNET hUrl = InternetOpenUrlA(hInternet, mediaUrl.c_str(), NULL, 0,
                                     INTERNET_FLAG_NO_CACHE_WRITE | INTERNET_FLAG_RELOAD | INTERNET_FLAG_SECURE, 0);
    if (!hUrl) {
        hUrl = InternetOpenUrlA(hInternet, mediaUrl.c_str(), NULL, 0, INTERNET_FLAG_NO_CACHE_WRITE | INTERNET_FLAG_RELOAD, 0);
    }

    if (!hUrl) {
        InternetCloseHandle(hInternet);
        return false;
    }

    char buffer[512];
    DWORD bufferLen = sizeof(buffer);
    DWORD index = 0;

    // Check Content-Length
    if (HttpQueryInfoA(hUrl, HTTP_QUERY_CONTENT_LENGTH, buffer, &bufferLen, &index)) {
        fileSize = std::stoull(buffer);
    } else {
        fileSize = 0;
    }

    // Check ETag
    bufferLen = sizeof(buffer);
    index = 0;
    if (HttpQueryInfoA(hUrl, HTTP_QUERY_ETAG, buffer, &bufferLen, &index)) {
        etag = std::string(buffer);
    }

    // Check Last-Modified
    bufferLen = sizeof(buffer);
    index = 0;
    if (HttpQueryInfoA(hUrl, HTTP_QUERY_LAST_MODIFIED, buffer, &bufferLen, &index)) {
        lastModified = std::string(buffer);
    }

    // Check Accept-Ranges
    bufferLen = sizeof(buffer);
    index = 0;
    if (HttpQueryInfoA(hUrl, HTTP_QUERY_ACCEPT_RANGES, buffer, &bufferLen, &index)) {
        std::string ranges(buffer);
        supportsRange = (ranges.find("bytes") != std::string::npos);
    } else {
        supportsRange = (fileSize > 0);
    }

    InternetCloseHandle(hUrl);
    InternetCloseHandle(hInternet);
    return true;
}

bool NativeDownloader::saveStateMetadata() {
    std::lock_guard<std::mutex> lock(chunkMutex);
    std::ofstream ofs(stateFile, std::ios::trunc);
    if (!ofs.is_open()) return false;

    ofs << "{\n";
    ofs << "  \"url\": \"" << mediaUrl << "\",\n";
    ofs << "  \"fileSize\": " << fileSize << ",\n";
    ofs << "  \"etag\": \"" << etag << "\",\n";
    ofs << "  \"lastModified\": \"" << lastModified << "\",\n";
    ofs << "  \"totalDownloaded\": " << totalDownloaded.load() << ",\n";
    ofs << "  \"chunks\": [\n";

    for (size_t i = 0; i < chunks.size(); ++i) {
        const auto& c = chunks[i];
        ofs << "    {\"id\": " << c.id 
            << ", \"startByte\": " << c.startByte 
            << ", \"endByte\": " << c.endByte 
            << ", \"downloadedBytes\": " << c.downloadedBytes 
            << ", \"completed\": " << (c.completed ? "true" : "false") << "}"
            << (i + 1 < chunks.size() ? "," : "") << "\n";
    }

    ofs << "  ]\n";
    ofs << "}\n";
    return true;
}

bool NativeDownloader::start() {
    if (isRunning.load()) return false;

    if (!queryFileInfo()) {
        std::cerr << "[Native C++ Engine] Failed to query file headers from URL: " << mediaUrl << std::endl;
        return false;
    }

    std::cout << "[Native C++ Engine] File Size: " << fileSize << " bytes, Range Support: " 
              << (supportsRange ? "YES" : "NO") << ", ETag: " << (etag.empty() ? "None" : etag) << std::endl;

    isRunning = true;
    isPaused = false;
    isComplete = false;
    totalDownloaded = 0;

    // Calculate chunks
    chunks.clear();
    if (supportsRange && fileSize > 0 && numThreads > 1) {
        uint64_t chunkSize = fileSize / numThreads;
        for (size_t i = 0; i < numThreads; ++i) {
            DownloadChunk chunk;
            chunk.id = i;
            chunk.startByte = i * chunkSize;
            chunk.endByte = (i == numThreads - 1) ? (fileSize - 1) : (chunk.startByte + chunkSize - 1);
            chunk.downloadedBytes = 0;
            chunk.completed = false;
            chunk.failed = false;
            chunk.retries = 0;
            chunks.push_back(chunk);
        }
    } else {
        DownloadChunk chunk;
        chunk.id = 0;
        chunk.startByte = 0;
        chunk.endByte = fileSize > 0 ? fileSize - 1 : 0;
        chunk.downloadedBytes = 0;
        chunk.completed = false;
        chunk.failed = false;
        chunk.retries = 0;
        chunks.push_back(chunk);
    }

    // Pre-allocate zero-fragmentation file on disk using Windows API
    HANDLE hFile = CreateFileA(outputFile.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile != INVALID_HANDLE_VALUE) {
        if (fileSize > 0) {
            LARGE_INTEGER li;
            li.QuadPart = fileSize;
            SetFilePointerEx(hFile, li, NULL, FILE_BEGIN);
            SetEndOfFile(hFile);
        }
        CloseHandle(hFile);
    }

    // Launch worker threads
    for (size_t i = 0; i < chunks.size(); ++i) {
        workerThreads.emplace_back(&NativeDownloader::downloadSegmentWorker, this, i);
    }

    // Launch progress & dynamic load-balancer thread
    std::thread progressThread(&NativeDownloader::updateProgressLoop, this);
    progressThread.detach();

    return true;
}

void NativeDownloader::checkAndDynamicReSplit() {
    std::lock_guard<std::mutex> lock(chunkMutex);
    if (!supportsRange || fileSize == 0) return;

    size_t largestRemainingIndex = chunks.size();
    uint64_t largestRemainingBytes = 0;

    // Find the chunk with the largest remaining bytes
    for (size_t i = 0; i < chunks.size(); ++i) {
        if (!chunks[i].completed && !chunks[i].failed) {
            uint64_t currentOffset = chunks[i].startByte + chunks[i].downloadedBytes;
            if (chunks[i].endByte > currentOffset) {
                uint64_t remaining = chunks[i].endByte - currentOffset;
                if (remaining > largestRemainingBytes) {
                    largestRemainingBytes = remaining;
                    largestRemainingIndex = i;
                }
            }
        }
    }

    // If largest remaining > 2MB, split it dynamically to re-balance work across threads
    const uint64_t MIN_SPLIT_THRESHOLD = 2 * 1024 * 1024; // 2MB
    if (largestRemainingIndex < chunks.size() && largestRemainingBytes > MIN_SPLIT_THRESHOLD) {
        auto& busyChunk = chunks[largestRemainingIndex];
        uint64_t currentOffset = busyChunk.startByte + busyChunk.downloadedBytes;
        uint64_t midPoint = currentOffset + (busyChunk.endByte - currentOffset) / 2;

        // Truncate busy chunk end byte
        uint64_t oldEndByte = busyChunk.endByte;
        busyChunk.endByte = midPoint;

        // Create new dynamic chunk for remaining half
        DownloadChunk newChunk;
        newChunk.id = chunks.size();
        newChunk.startByte = midPoint + 1;
        newChunk.endByte = oldEndByte;
        newChunk.downloadedBytes = 0;
        newChunk.completed = false;
        newChunk.failed = false;
        newChunk.retries = 0;

        chunks.push_back(newChunk);
        size_t newId = chunks.size() - 1;

        std::cout << "[Native C++ Dynamic Re-Split] Dynamic load balancing: split chunk " << busyChunk.id 
                  << " into new chunk " << newId << " (" << (newChunk.endByte - newChunk.startByte + 1) / 1024 << " KB)" << std::endl;

        workerThreads.emplace_back(&NativeDownloader::downloadSegmentWorker, this, newId);
    }
}

void NativeDownloader::downloadSegmentWorker(size_t chunkId) {
    DownloadChunk& chunk = chunks[chunkId];

    HINTERNET hInternet = InternetOpenA("DownloaderEngineChunk/1.0", INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
    if (!hInternet) {
        chunk.failed = true;
        return;
    }

    std::string headers = "";
    if (supportsRange && fileSize > 0) {
        headers = "Range: bytes=" + std::to_string(chunk.startByte + chunk.downloadedBytes) + "-" + std::to_string(chunk.endByte) + "\r\n";
        if (!etag.empty()) {
            headers += "If-Match: " + etag + "\r\n";
        }
    }

    DWORD flags = INTERNET_FLAG_NO_CACHE_WRITE | INTERNET_FLAG_RELOAD | INTERNET_FLAG_SECURE;
    HINTERNET hUrl = InternetOpenUrlA(hInternet, mediaUrl.c_str(), headers.c_str(), (DWORD)headers.length(), flags, 0);
    if (!hUrl) {
        flags = INTERNET_FLAG_NO_CACHE_WRITE | INTERNET_FLAG_RELOAD;
        hUrl = InternetOpenUrlA(hInternet, mediaUrl.c_str(), headers.c_str(), (DWORD)headers.length(), flags, 0);
    }

    if (!hUrl) {
        InternetCloseHandle(hInternet);
        chunk.failed = true;
        return;
    }

    HANDLE hFile = CreateFileA(outputFile.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        InternetCloseHandle(hUrl);
        InternetCloseHandle(hInternet);
        chunk.failed = true;
        return;
    }

    // Seek to start byte
    LARGE_INTEGER li;
    li.QuadPart = chunk.startByte + chunk.downloadedBytes;
    SetFilePointerEx(hFile, li, NULL, FILE_BEGIN);

    char buffer[64 * 1024]; // 64KB buffer for high throughput
    DWORD bytesRead = 0;

    while (isRunning.load() && !isPaused.load()) {
        if (InternetReadFile(hUrl, buffer, sizeof(buffer), &bytesRead)) {
            if (bytesRead == 0) break;

            DWORD bytesWritten = 0;
            WriteFile(hFile, buffer, bytesRead, &bytesWritten, NULL);

            chunk.downloadedBytes += bytesWritten;
            totalDownloaded.fetch_add(bytesWritten);

            // Token bucket speed limiter enforcement
            uint64_t limit = speedLimitBytesPerSec.load();
            if (limit > 0) {
                double expectedSec = (double)bytesWritten / (limit / numThreads);
                DWORD sleepMs = (DWORD)(expectedSec * 1000.0);
                if (sleepMs > 0 && sleepMs < 5000) {
                    Sleep(sleepMs);
                }
            }
        } else {
            break;
        }
    }

    CloseHandle(hFile);
    InternetCloseHandle(hUrl);
    InternetCloseHandle(hInternet);

    if (chunk.startByte + chunk.downloadedBytes >= chunk.endByte || fileSize == 0) {
        chunk.completed = true;
    }
}

void NativeDownloader::updateProgressLoop() {
    auto lastTime = std::chrono::high_resolution_clock::now();
    uint64_t lastBytes = 0;

    while (isRunning.load() && !isComplete.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));

        auto now = std::chrono::high_resolution_clock::now();
        std::chrono::duration<double> elapsed = now - lastTime;

        uint64_t currentBytes = totalDownloaded.load();
        uint64_t bytesDelta = currentBytes - lastBytes;
        double speed = (elapsed.count() > 0) ? (bytesDelta / elapsed.count()) : 0;

        lastTime = now;
        lastBytes = currentBytes;

        // Save session state to .ddl.json every 2 seconds
        saveStateMetadata();

        // Perform dynamic thread load balancing
        checkAndDynamicReSplit();

        // Check if all chunks complete
        bool allDone = true;
        {
            std::lock_guard<std::mutex> lock(chunkMutex);
            for (const auto& c : chunks) {
                if (!c.completed) {
                    allDone = false;
                    break;
                }
            }
        }

        if (allDone || (fileSize > 0 && currentBytes >= fileSize)) {
            isComplete = true;
            isRunning = false;

            // Delete temporary state metadata file upon clean finish
            DeleteFileA(stateFile.c_str());
        }

        if (progressCb) {
            DownloadProgress prog;
            prog.totalBytes = fileSize;
            prog.downloadedBytes = currentBytes;
            prog.speedBytesPerSec = speed;
            prog.progressPercent = (fileSize > 0) ? ((double)currentBytes / fileSize * 100.0) : 0;
            prog.activeThreads = (uint32_t)numThreads;
            prog.etag = etag;
            prog.isResumable = supportsRange;
            progressCb(prog);
        }
    }
}

void NativeDownloader::pause() { isPaused = true; saveStateMetadata(); }
void NativeDownloader::resume() { isPaused = false; }

void NativeDownloader::cancel() {
    isRunning = false;
    for (auto& t : workerThreads) {
        if (t.joinable()) t.join();
    }
    workerThreads.clear();
}

DownloadProgress NativeDownloader::getProgress() const {
    DownloadProgress p;
    p.totalBytes = fileSize;
    p.downloadedBytes = totalDownloaded.load();
    p.speedBytesPerSec = 0;
    p.progressPercent = (fileSize > 0) ? ((double)p.downloadedBytes / fileSize * 100.0) : 0;
    p.activeThreads = (uint32_t)numThreads;
    p.etag = etag;
    p.isResumable = supportsRange;
    return p;
}

} // namespace DownloaderCore
