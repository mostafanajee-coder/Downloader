#include "downloader.hpp"
#include <iostream>
#include <iomanip>

int main(int argc, char* argv[]) {
    std::cout << "=================================================" << std::endl;
    std::cout << "  Downloader Native C++ Multi-Threaded Engine    " << std::endl;
    std::cout << "=================================================" << std::endl;

    if (argc < 3) {
        std::cout << "Usage: downloader.exe <URL> <OutputFile> [ThreadCount]" << std::endl;
        std::cout << "Example: downloader.exe \"https://example.com/video.mp4\" \"C:\\Downloads\\video.mp4\" 8" << std::endl;
        return 1;
    }

    std::string url = argv[1];
    std::string outputPath = argv[2];
    size_t threads = (argc >= 4) ? std::stoul(argv[3]) : 8;

    std::cout << "[C++ Engine] Target URL: " << url << std::endl;
    std::cout << "[C++ Engine] Target Output: " << outputPath << std::endl;
    std::cout << "[C++ Engine] Active Threads: " << threads << std::endl;

    DownloaderCore::NativeDownloader downloader(url, outputPath, threads);

    downloader.setProgressCallback([](const DownloaderCore::DownloadProgress& prog) {
        double speedMB = prog.speedBytesPerSec / (1024.0 * 1024.0);
        double downloadedMB = prog.downloadedBytes / (1024.0 * 1024.0);
        double totalMB = prog.totalBytes / (1024.0 * 1024.0);

        std::cout << "\r[Downloading] " 
                  << std::fixed << std::setprecision(1) << prog.progressPercent << "% | "
                  << downloadedMB << " MB / " << totalMB << " MB | "
                  << speedMB << " MB/s | Threads: " << prog.activeThreads << "   " << std::flush;
    });

    if (!downloader.start()) {
        std::cerr << "\n[C++ Engine Error] Failed to start download task." << std::endl;
        return 1;
    }

    while (!downloader.isFinished()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    std::cout << "\n=================================================" << std::endl;
    std::cout << "[SUCCESS] File download completed via C++ Native Engine!" << std::endl;
    std::cout << "=================================================" << std::endl;

    return 0;
}
