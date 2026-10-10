using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
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
                // 如果已有实例在运行，尝试直接呼出界面
                string browserExe = FindBrowserExecutable();
                if (!string.IsNullOrEmpty(browserExe))
                {
                    LaunchAppWindow(browserExe);
                }
                return;
            }

            // 注册进程退出清理钩子
            AppDomain.CurrentDomain.ProcessExit += OnProcessExit;

            try
            {
                // 3. 寻找 Node.js
                string nodeExe = FindNodeExecutable();
                if (string.IsNullOrEmpty(nodeExe))
                {
                    MessageBox.Show("未检测到 Node.js 运行环境！\n请确保已安装 Node.js (v18 或以上)。", "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                // 4. 寻找浏览器 (优先 Edge 独立应用模式，其次 Chrome)
                string browserExe = FindBrowserExecutable();
                if (string.IsNullOrEmpty(browserExe))
                {
                    MessageBox.Show("未检测到 Microsoft Edge 或 Google Chrome 浏览器！", "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                // 5. 确保端口 3038 就绪或启动本地伴侣服务
                bool alreadyRunning = IsServiceHealthy(3038);
                if (!alreadyRunning)
                {
                    // 若端口有残留孤儿进程但无正常心跳，先清理
                    if (IsPortOccupiedTcp(3038))
                    {
                        KillProcessOnPort(3038);
                        Thread.Sleep(300);
                    }

                    StartNodeServer(nodeExe);

                    bool ready = WaitForServerReady(3038, 8000);
                    if (!ready)
                    {
                        // 启动依然未就绪时的容错：如果 TCP 端口通了也视为就绪
                        if (!IsPortOccupiedTcp(3038))
                        {
                            MessageBox.Show("本地伴侣服务启动超时，请尝试在命令行运行：\nnode core/server.mjs\n排查报错原因。", "服务超时", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                            return;
                        }
                    }
                }

                // 6. 启动原生风格的应用窗口
                LaunchAppWindow(browserExe);

                // 7. 守护等待：只要前端窗口在运行，前端就会持续发送心跳保活本地伴侣服务；
                // 当用户关闭前端窗口时，前端通知退出或心跳超时，伴侣服务安全退出后随之结束。
                if (nodeProcess != null && !nodeProcess.HasExited)
                {
                    nodeProcess.WaitForExit();
                }
                else
                {
                    // 若伴侣服务由独立实例维护，循环等待直到端口释放
                    while (IsPortOccupiedTcp(3038))
                    {
                        Thread.Sleep(1000);
                    }
                }
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

        // 毫秒级极速健康探测 (完全直连本机，禁用任何系统 Web 代理)
        private static bool IsServiceHealthy(int port)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/local/health");
                req.Proxy = null; // 关键：绝对禁止使用系统代理
                req.Timeout = 1000;
                req.ReadWriteTimeout = 1000;
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

        // 纯 TCP 端口物理握手 (1毫秒检测端口是否处于 Listen 状态)
        private static bool IsPortOccupiedTcp(int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult ar = client.BeginConnect("127.0.0.1", port, null, null);
                    bool success = ar.AsyncWaitHandle.WaitOne(200);
                    if (success && client.Connected)
                    {
                        client.EndConnect(ar);
                        return true;
                    }
                }
            }
            catch { }
            return false;
        }

        private static bool WaitForServerReady(int port, int timeoutMs)
        {
            int elapsed = 0;
            while (elapsed < timeoutMs)
            {
                if (IsServiceHealthy(port) || IsPortOccupiedTcp(port)) return true;
                Thread.Sleep(150);
                elapsed += 150;
            }
            return false;
        }

        private static void KillProcessOnPort(int port)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell",
                    Arguments = string.Format("-NoProfile -Command \"Get-NetTCPConnection -LocalPort {0} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}\"", port),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit(2000);
                }
            }
            catch { }
        }

        private static void LaunchAppWindow(string browserExe)
        {
            string profileDir = Path.Combine(appDir, ".profile");
            string appUrl = "http://127.0.0.1:3038";
            string args = string.Format("--app=\"{0}\" --window-size=1120,760 --user-data-dir=\"{1}\" --no-first-run --no-default-browser-check", appUrl, profileDir);

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = browserExe,
                Arguments = args,
                WorkingDirectory = appDir,
                UseShellExecute = false
            };

            Process.Start(psi);
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
                req.Proxy = null;
                req.Method = "POST";
                req.Timeout = 1000;
                using (req.GetResponse()) { }
            }
            catch { }

            // 2. 兜底恢复所有物理网卡为 DHCP
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
                    p.WaitForExit(2000);
                }
            }
            catch { }
        }
    }
}
