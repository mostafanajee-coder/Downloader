#ifndef DOWNLOADER_HPP
#define DOWNLOADER_HPP

#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <functional>
#include <chrono>
#include <mutex>

namespace DownloaderCore {

struct DownloadChunk {
    size_t id;
    uint64_t startByte;
    uint64_t endByte;
    uint64_t downloadedBytes;
    bool completed;
    bool failed;
    uint32_t retries;
};

struct DownloadProgress {
    uint64_t totalBytes;
    uint64_t downloadedBytes;
    double speedBytesPerSec;
    double progressPercent;
    uint32_t activeThreads;
    std::string etag;
    bool isResumable;
};

using ProgressCallback = std::function<void(const DownloadProgress&)>;

class NativeDownloader {
public:
    NativeDownloader(const std::string& url, const std::string& outputPath, size_t threadCount = 8);
    ~NativeDownloader();

    bool start();
    void pause();
    void resume();
    void cancel();

    void setSpeedLimit(uint64_t bytesPerSec) { speedLimitBytesPerSec = bytesPerSec; }
    void setProgressCallback(ProgressCallback callback) { progressCb = callback; }
    DownloadProgress getProgress() const;
    bool isFinished() const { return isComplete.load(); }

private:
    std::string mediaUrl;
    std::string outputFile;
    std::string stateFile;
    size_t numThreads;

    uint64_t fileSize;
    bool supportsRange;
    std::string etag;
    std::string lastModified;

    std::vector<DownloadChunk> chunks;
    std::vector<std::thread> workerThreads;
    std::mutex chunkMutex;

    std::atomic<bool> isRunning;
    std::atomic<bool> isPaused;
    std::atomic<bool> isComplete;
    std::atomic<uint64_t> totalDownloaded;
    std::atomic<uint64_t> speedLimitBytesPerSec;

    ProgressCallback progressCb;

    bool queryFileInfo();
    void downloadSegmentWorker(size_t chunkId);
    void updateProgressLoop();

    // IDM 100% Core Features: Dynamic Re-Splitting & Session Recovery
    void checkAndDynamicReSplit();
    bool saveStateMetadata();
    bool loadStateMetadata();
};

} // namespace DownloaderCore

#endif // DOWNLOADER_HPP
