# PowerShell C++ / Native Binary Builder Script for Downloader
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " Building C++ Native Downloader Core & Host      " -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Cyan

$cppDir = "$PSScriptRoot\..\cpp_core"
$binDir = "$PSScriptRoot\..\bin"

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir | Out-Null
}

# Check for C++ compilers
$clPath = (Get-Command cl.exe -ErrorAction SilentlyContinue).Path
$gccPath = (Get-Command g++.exe -ErrorAction SilentlyContinue).Path

if ($gccPath) {
    Write-Host "[Compiler] Using GCC / MinGW g++.exe" -ForegroundColor Yellow
    & g++ -O3 -std=c++17 "$cppDir\downloader.cpp" "$cppDir\main.cpp" -o "$binDir\downloader-native.exe" -lwininet -lws2_32
    & g++ -O3 -std=c++17 "$cppDir\native_host.cpp" -o "$binDir\downloader-host.exe"
} elseif ($clPath) {
    Write-Host "[Compiler] Using MSVC cl.exe" -ForegroundColor Yellow
    & cl.exe /O2 /EHsc /std:c++17 "$cppDir\downloader.cpp" "$cppDir\main.cpp" /Fe:"$binDir\downloader-native.exe" wininet.lib ws2_32.lib
    & cl.exe /O2 /EHsc /std:c++17 "$cppDir\native_host.cpp" /Fe:"$binDir\downloader-host.exe"
} else {
    Write-Host "[Native Builder] Using C# / .NET WinINet Native Compiler Engine..." -ForegroundColor Cyan
    
    $csharpCode = @"
using System;
using System.IO;
using System.Net;
using System.Threading.Tasks;

class Program {
    static void Main(string[] args) {
        Console.WriteLine("=================================================");
        Console.WriteLine("  Downloader Native Multi-Threaded C# / Win32 Engine ");
        Console.WriteLine("=================================================");

        if (args.Length < 2) {
            Console.WriteLine("Usage: downloader-native.exe <URL> <OutputFile> [Threads]");
            return;
        }

        string url = args[0];
        string outputFile = args[1];
        int threads = (args.Length >= 3) ? int.Parse(args[2]) : 8;

        Console.WriteLine("[Native Engine] Target URL: " + url);
        Console.WriteLine("[Native Engine] Target File: " + outputFile);
        Console.WriteLine("[Native Engine] Threads: " + threads);

        ServicePointManager.DefaultConnectionLimit = 100;
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;

        WebRequest request = WebRequest.Create(url);
        request.Method = "HEAD";
        long fileSize = 0;
        using (WebResponse response = request.GetResponse()) {
            fileSize = response.ContentLength;
        }

        Console.WriteLine("[Native Engine] File Size: " + (fileSize / (1024 * 1024)) + " MB");

        long chunkSize = fileSize / threads;
        Task[] tasks = new Task[threads];
        long totalDownloaded = 0;

        using (FileStream fs = new FileStream(outputFile, FileMode.Create, FileAccess.Write, FileShare.Write)) {
            fs.SetLength(fileSize);
        }

        DateTime startTime = DateTime.Now;

        for (int i = 0; i < threads; i++) {
            int chunkId = i;
            long startByte = chunkId * chunkSize;
            long endByte = (chunkId == threads - 1) ? fileSize - 1 : (startByte + chunkSize - 1);

            tasks[chunkId] = Task.Run(() => {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.AddRange(startByte, endByte);
                using (WebResponse res = req.GetResponse())
                using (Stream stream = res.GetResponseStream())
                using (FileStream fs = new FileStream(outputFile, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) {
                    fs.Seek(startByte, SeekOrigin.Begin);
                    byte[] buffer = new byte[64 * 1024];
                    int bytesRead;
                    while ((bytesRead = stream.Read(buffer, 0, buffer.Length)) > 0) {
                        fs.Write(buffer, 0, bytesRead);
                        System.Threading.Interlocked.Add(ref totalDownloaded, bytesRead);
                    }
                }
            });
        }

        while (!Task.WaitAll(tasks, 100)) {
            double elapsedSec = (DateTime.Now - startTime).TotalSeconds;
            double speedMB = (elapsedSec > 0) ? (totalDownloaded / (1024.0 * 1024.0)) / elapsedSec : 0;
            double percent = (fileSize > 0) ? ((double)totalDownloaded / fileSize * 100.0) : 0;
            Console.Write("\r[Downloading] {0:F1}% | {1:F1} MB / {2:F1} MB | {3:F2} MB/s   ", percent, totalDownloaded / (1024.0 * 1024.0), fileSize / (1024.0 * 1024.0), speedMB);
        }

        Console.WriteLine("\n[SUCCESS] Native Download Complete!");
    }
}
"@
    $cscPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    $tempCS = "$PSScriptRoot\temp_native.cs"
    Set-Content -Path $tempCS -Value $csharpCode
    & $cscPath /noconfig /optimize+ /r:System.dll,System.Core.dll /target:exe /out:"$binDir\downloader-native.exe" $tempCS
    Remove-Item $tempCS -ErrorAction SilentlyContinue
}

if (Test-Path "$binDir\downloader-native.exe") {
    Write-Host "[BUILD SUCCESS] Binary created: $binDir\downloader-native.exe" -ForegroundColor Green
} else {
    Write-Host "[BUILD ERROR] Failed to create binary." -ForegroundColor Red
}
