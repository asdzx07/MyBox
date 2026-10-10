using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace MyBox.Client
{
    static class Program
    {
        private static Process nodeProcess = null;
        private static string appDir = "";
        private static Mutex appMutex = null;

        [STAThread]
        static void Main(string[] args)
        {
            appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');

            // 1. 处理快捷命令行恢复选项
            if (args.Length > 0)
            {
                string arg = args[0].ToLowerInvariant();
                if (arg == "--reset" || arg == "--disconnect" || arg == "-r")
                {
                    ResetNetworkDirectly();
                    MessageBox.Show("已成功恢复 Windows 默认网络（DHCP 自动获取 IP 与 DNS）！", "MyBox 网络恢复", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
            }

            // 2. 单实例检查
            bool createdNew;
            appMutex = new Mutex(true, "Global\\MyBox_Windows_Client_Singleton_Mutex", out createdNew);
            if (!createdNew)
            {
                MessageBox.Show("MyBox 客户端已经在运行中。\n如需重启，请先在任务栏退出已有实例。", "MyBox 客户端", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            // 注册退出清理钩子
            AppDomain.CurrentDomain.ProcessExit += OnProcessExit;

            try
            {
                // 3. 寻找 Node.js
                string nodeExe = FindNodeExecutable();
                if (string.IsNullOrEmpty(nodeExe))
                {
                    MessageBox.Show("未检测到 Node.js 运行环境！\n请确保已安装 Node.js，或者系统 PATH 中包含 node.exe。", "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                // 4. 寻找浏览器 (优先 Edge 独立应用模式，其次 Chrome)
                string browserExe = FindBrowserExecutable();
                if (string.IsNullOrEmpty(browserExe))
                {
                    MessageBox.Show("未检测到 Microsoft Edge 或 Google Chrome 浏览器！", "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                // 5. 启动本地后台伴侣服务 (Node.js 端口 3038)
                StartNodeServer(nodeExe);

                // 6. 等待本地服务就绪
                bool ready = WaitForServerReady(3038, 6000);
                if (!ready)
                {
                    MessageBox.Show("本地伴侣服务启动超时，请检查端口 3038 是否被占用。", "服务超时", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }

                // 7. 启动原生风格的应用窗口
                LaunchAppWindow(browserExe);
            }
            catch (Exception ex)
            {
                MessageBox.Show("程序发生异常: " + ex.Message, "MyBox 客户端错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                CleanupAndRestoreNetwork();
                if (appMutex != null)
                {
                    try { appMutex.ReleaseMutex(); } catch { }
                    appMutex.Close();
                }
            }
        }

        private static string FindNodeExecutable()
        {
            string localNode = Path.Combine(appDir, "node.exe");
            if (File.Exists(localNode)) return localNode;

            string nvmNode = @"C:\nvm4w\nodejs\node.exe";
            if (File.Exists(nvmNode)) return nvmNode;

            string pfNode = @"C:\Program Files\nodejs\node.exe";
            if (File.Exists(pfNode)) return pfNode;

            string pf86Node = @"C:\Program Files (x86)\nodejs\node.exe";
            if (File.Exists(pf86Node)) return pf86Node;

            // 搜索 PATH 环境变量
            string pathEnv = Environment.GetEnvironmentVariable("PATH");
            if (!string.IsNullOrEmpty(pathEnv))
            {
                string[] paths = pathEnv.Split(';');
                foreach (string p in paths)
                {
                    try
                    {
                        string candidate = Path.Combine(p.Trim(), "node.exe");
                        if (File.Exists(candidate)) return candidate;
                    }
                    catch { }
                }
            }

            return null;
        }

        private static string FindBrowserExecutable()
        {
            string edge1 = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
            if (File.Exists(edge1)) return edge1;

            string edge2 = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
            if (File.Exists(edge2)) return edge2;

            string chrome1 = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
            if (File.Exists(chrome1)) return chrome1;

            string chrome2 = @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe";
            if (File.Exists(chrome2)) return chrome2;

            return null;
        }

        private static void StartNodeServer(string nodeExe)
        {
            // 先尝试检查端口 3038 是否已有心跳
            if (IsPortListening(3038))
            {
                return;
            }

            string serverScript = Path.Combine(appDir, "core\\server.mjs");
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "\"" + serverScript + "\"",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            nodeProcess = Process.Start(psi);
        }

        private static bool IsPortListening(int port)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/local/status");
                req.Timeout = 500;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool WaitForServerReady(int port, int timeoutMs)
        {
            int elapsed = 0;
            while (elapsed < timeoutMs)
            {
                if (IsPortListening(port)) return true;
                Thread.Sleep(200);
                elapsed += 200;
            }
            return false;
        }

        private static void LaunchAppWindow(string browserExe)
        {
            string profileDir = Path.Combine(appDir, ".profile");
            string appUrl = "http://127.0.0.1:3038";
            string args = string.Format("--app=\"{0}\" --window-size=1100,740 --user-data-dir=\"{1}\" --no-first-run --no-default-browser-check", appUrl, profileDir);

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = browserExe,
                Arguments = args,
                WorkingDirectory = appDir,
                UseShellExecute = false
            };

            Process browserProc = Process.Start(psi);
            if (browserProc != null)
            {
                // 等待用户关闭应用窗口
                browserProc.WaitForExit();
            }
        }

        private static void OnProcessExit(object sender, EventArgs e)
        {
            CleanupAndRestoreNetwork();
        }

        private static void CleanupAndRestoreNetwork()
        {
            // 1. 发送 HTTP 请求恢复网络并退出服务
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3038/api/local/exit");
                req.Method = "POST";
                req.Timeout = 1000;
                using (req.GetResponse()) { }
            }
            catch { }

            // 2. 兜底恢复本地物理网卡为 DHCP
            ResetNetworkDirectly();

            // 3. 杀掉后台 node 服务进程
            if (nodeProcess != null && !nodeProcess.HasExited)
            {
                try { nodeProcess.Kill(); } catch { }
            }
        }

        private static void ResetNetworkDirectly()
        {
            string[] ifaces = new string[] { "以太网", "WLAN", "Wi-Fi", "Ethernet", "本地连接" };
            foreach (string iface in ifaces)
            {
                try
                {
                    RunCmd("netsh", "interface ip set address name=\"" + iface + "\" source=dhcp");
                    RunCmd("netsh", "interface ip set dns name=\"" + iface + "\" source=dhcp");
                }
                catch { }
            }
            try { RunCmd("ipconfig", "/flushdns"); } catch { }
        }

        private static void RunCmd(string exe, string args)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = exe,
                    Arguments = args,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit(1500);
                }
            }
            catch { }
        }
    }
}
