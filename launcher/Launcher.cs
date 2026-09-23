// KobraMorda.exe - a thin native launcher, not a bundle of the app itself.
//
// Why a launcher instead of packaging the whole app into one exe: the
// backend is ESM TypeScript with a native ffmpeg binary dependency and a
// filesystem-served frontend build - bundling all of that into a single
// Node SEA/pkg binary is fragile and was judged not worth the risk for a
// "double-click to start" convenience feature. This launcher instead does
// exactly what a human would do by hand: build once if needed, start the
// server hidden, open the dashboard. See KobraMorda.cmd for the equivalent
// with a visible console, kept for anyone who wants to see live logs.
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;

internal static class Launcher
{
    private const int Port = 7130;
    private const string Url = "http://localhost:7130/";

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    private const uint MB_ICONERROR = 0x10;
    private const uint MB_ICONINFORMATION = 0x40;

    private static void Info(string text)
    {
        MessageBoxW(IntPtr.Zero, text, "KobraMorda", MB_ICONINFORMATION);
    }

    private static void Error(string text)
    {
        MessageBoxW(IntPtr.Zero, text, "KobraMorda", MB_ICONERROR);
    }

    private static string BaseDir()
    {
        return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    }

    private static bool IsPortOpen(int port, int timeoutMs)
    {
        try
        {
            using (var client = new TcpClient())
            {
                var result = client.BeginConnect("127.0.0.1", port, null, null);
                if (!result.AsyncWaitHandle.WaitOne(timeoutMs)) return false;
                client.EndConnect(result);
                return client.Connected;
            }
        }
        catch
        {
            return false;
        }
    }

    private static void OpenBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            // no default browser association - not fatal, the user can open the URL themselves
        }
    }

    /// <summary>PATH first, then the two common install locations - covers a normal npm.js installer run.</summary>
    private static string FindNode()
    {
        string[] candidates =
        {
            "node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
        };
        foreach (var candidate in candidates)
        {
            try
            {
                var psi = new ProcessStartInfo(candidate, "--version")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using (var p = Process.Start(psi))
                {
                    p.WaitForExit(5000);
                    if (p.ExitCode == 0) return candidate;
                }
            }
            catch
            {
                // not found at this candidate - try the next
            }
        }
        return null;
    }

    /// <summary>Runs a visible cmd.exe with the given script, waits for it, returns its exit code.</summary>
    private static int RunVisible(string script, string title)
    {
        var psi = new ProcessStartInfo("cmd.exe", "/c title " + title + " && " + script)
        {
            UseShellExecute = false,
            CreateNoWindow = false,
        };
        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    private static void StartHidden(string backendDir)
    {
        var psi = new ProcessStartInfo("cmd.exe", "/c node dist\\server.js >> data\\bridge.log 2>&1")
        {
            WorkingDirectory = backendDir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        Process.Start(psi);
    }

    [STAThread]
    private static void Main()
    {
        // Already running (a previous launch, or the visible .cmd) - just open the dashboard.
        if (IsPortOpen(Port, 400))
        {
            OpenBrowser(Url);
            return;
        }

        var baseDir = BaseDir();
        var backendDir = Path.Combine(baseDir, "backend");
        var frontendDir = Path.Combine(baseDir, "frontend");

        if (!Directory.Exists(backendDir) || !Directory.Exists(frontendDir))
        {
            Error("Не найдены папки backend/frontend рядом с KobraMorda.exe.\nПоложите его в корень проекта.");
            return;
        }

        if (FindNode() == null)
        {
            Error("Не найден Node.js.\nУстановите его с https://nodejs.org (версия 20 или новее) и запустите KobraMorda.exe снова.");
            return;
        }

        var needsSetup = !File.Exists(Path.Combine(backendDir, "dist", "server.js")) || !File.Exists(Path.Combine(frontendDir, "dist", "index.html"));
        if (needsSetup)
        {
            Info("Первый запуск: сейчас соберётся проект, это займёт пару минут.\nОткроется окно с ходом установки - не закрывайте его.");
            var script = string.Format(
                "cd /d \"{0}\" && npm install && npm run build && cd /d \"{1}\" && npm install && npm run build",
                backendDir,
                frontendDir);
            var code = RunVisible(script, "KobraMorda - первая установка");
            if (code != 0)
            {
                Error("Установка не завершилась успешно (код " + code + ").\nПроверьте окно установки и повторите запуск.");
                return;
            }
        }

        StartHidden(backendDir);

        for (var i = 0; i < 30; i++)
        {
            if (IsPortOpen(Port, 500)) break;
        }
        OpenBrowser(Url);
    }
}
