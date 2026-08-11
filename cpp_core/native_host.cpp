#include <iostream>
#include <string>
#include <vector>
#include <io.h>
#include <fcntl.h>
#include <windows.h>

// Ultra-fast Native Messaging Host in C++ for IDM Chrome Extension
void setBinaryMode() {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
}

std::string readMessage() {
    uint32_t length = 0;
    if (std::cin.read(reinterpret_cast<char*>(&length), sizeof(length))) {
        if (length == 0 || length > 10 * 1024 * 1024) return ""; // Protection against oversized payload
        std::vector<char> buffer(length);
        if (std::cin.read(buffer.data(), length)) {
            return std::string(buffer.data(), length);
        }
    }
    return "";
}

void sendMessage(const std::string& jsonMsg) {
    uint32_t length = static_cast<uint32_t>(jsonMsg.size());
    std::cout.write(reinterpret_cast<const char*>(&length), sizeof(length));
    std::cout.write(jsonMsg.data(), length);
    std::cout.flush();
}

int main() {
    setBinaryMode();

    while (std::cin.good()) {
        std::string inputMsg = readMessage();
        if (inputMsg.empty()) break;

        // Construct C++ Native Response
        std::string response = "{\"status\":\"ok\",\"engine\":\"Native C++ Downloader Core\",\"version\":\"1.0.0\"}";
        sendMessage(response);
    }

    return 0;
}
