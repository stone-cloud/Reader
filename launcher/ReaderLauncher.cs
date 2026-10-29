// Reader Windows 启动器（r2）
// ---------------------------------------------------------------------------
// 目标：双击 Reader.exe → 后台启动本地静态服务器 → 自动打开浏览器，
//       并提供一个**始终可见**的小窗口（显示地址 + 打开/复制/退出按钮），
//       不再只依赖托盘图标，避免“双击没反应”的观感问题。
//
// r2 相比 r1 的修复：
//   1. 先创建窗口与托盘，再在后台线程尝试打开浏览器：浏览器打开失败/卡住
//      也不会阻塞 UI，窗口会给出可见的错误与可点击地址；
//   2. 同实例二次启动不再依赖 port.txt：通过命名管道通知已运行实例打开浏览器；
//      管道失败时退回默认端口并直接打开浏览器，不会静默退出；
//   3. 端口/日志写入增加 %TEMP% 与 exe 同目录兜底；
//   4. 新图标（构建脚本生成多尺寸 ICO），窗口/托盘/任务栏统一使用；
//   5. 增加 `--no-ui`（只跑服务，便于自动化验证）与 `--force-new`（调试用）。
//
// 编译：由 launcher/build.ps1 调用 Windows 自带 .NET Framework csc.exe 完成。
// 依赖：.NET Framework 4.x（Windows 10/11 自带）。
// ---------------------------------------------------------------------------

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace ReaderLauncher
{
    internal static class Program
    {
        private const string AppTitle = "Reader";
        private const string MutexName = @"Local\ReaderLauncher-v0.0.6";
        private const string PipeName = "ReaderLauncherOpen-v0.0.6";
        internal const int DefaultPort = 8080;
        private const int MaxPortAttempts = 20;

        private static string _dataDir = null;

        [STAThread]
        private static void Main(string[] args)
        {
            bool noBrowser = HasFlag(args, "--no-browser");
            bool noUi = HasFlag(args, "--no-ui");
            bool forceNew = HasFlag(args, "--force-new");
            int requestedPort = ReadPortArg(args);

            bool createdNew = true;
            Mutex mutex = new Mutex(true, MutexName, out createdNew);
            try
            {
                if (!createdNew && !forceNew)
                {
                    HandleExistingInstance(noBrowser);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += (sender, e) => Log("ThreadException", e.Exception);
                AppDomain.CurrentDomain.UnhandledException += (sender, e) => Log("UnhandledException", e.ExceptionObject as Exception);

                StaticServer server = null;
                try
                {
                    server = new StaticServer();
                    int port = server.Start(requestedPort > 0 ? requestedPort : DefaultPort, requestedPort > 0 ? 1 : MaxPortAttempts);
                    WritePortFile(port);

                    if (noUi)
                    {
                        // 仅服务模式（自动化验证用）：不建窗口/托盘，进程保持到被结束
                        server.WaitForExit();
                        return;
                    }

                    using (var context = new AppContext(server, port, !noBrowser))
                    {
                        StartOpenPipeServer(context.OpenBrowserFromOtherInstance);
                        Application.Run(context);
                    }

                    WritePortFile(0);
                }
                catch (Exception ex)
                {
                    Log("Startup", ex);
                    MessageBox.Show(
                        "Reader 启动失败：\n\n" + ex.Message +
                        "\n\n如果 8080 端口被其它程序占用，请关闭占用程序后重试。",
                        AppTitle + " · 启动失败",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }
                finally
                {
                    if (server != null) server.Stop();
                }
            }
            finally
            {
                try { if (createdNew) mutex.ReleaseMutex(); } catch { }
                mutex.Dispose();
            }
        }

        // 已有实例在运行：优先通过命名管道让它打开浏览器；失败则不静默退出。
        private static void HandleExistingInstance(bool noBrowser)
        {
            if (noBrowser) return;

            if (TrySendOpenCommandToRunningInstance())
            {
                return;
            }

            int port = ReadPortFile();
            if (port <= 0) port = DefaultPort;
            string url = UrlForPort(port);
            try
            {
                OpenBrowser(url);
            }
            catch (Exception ex)
            {
                Log("OpenExistingInstance", ex);
                MessageBox.Show(
                    "Reader 似乎已经在后台运行。\n\n请手动在浏览器打开：\n" + url +
                    "\n\n如果页面无法访问，请在任务管理器中结束 Reader.exe 后重试。",
                    AppTitle + " · 已在运行",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
        }

        private static bool HasFlag(string[] args, string flag)
        {
            if (args == null) return false;
            foreach (var arg in args)
            {
                if (string.Equals(arg, flag, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static int ReadPortArg(string[] args)
        {
            if (args == null) return 0;
            for (int i = 0; i < args.Length; i++)
            {
                int value;
                if (string.Equals(args[i], "--port", StringComparison.OrdinalIgnoreCase)
                    && i + 1 < args.Length
                    && int.TryParse(args[i + 1], out value)
                    && value > 0 && value < 65536)
                {
                    return value;
                }
            }
            return 0;
        }

        internal static string UrlForPort(int port)
        {
            return "http://127.0.0.1:" + port + "/";
        }

        internal static void OpenBrowser(string url)
        {
            // Launch through Windows default HTTP handler on an STA UI thread.
            try
            {
                var startInfo = new ProcessStartInfo(url);
                startInfo.UseShellExecute = true;
                Process.Start(startInfo);
            }
            catch (Exception firstError)
            {
                Log("ShellBrowserLaunch", firstError);
                // Explorer is an alternative way to dispatch an URL to the default browser.
                var fallback = new ProcessStartInfo("explorer.exe", url);
                fallback.UseShellExecute = true;
                Process.Start(fallback);
            }
        }

        // ---------- 命名管道：通知已运行实例 ----------
        private static void StartOpenPipeServer(Action onOpen)
        {
            var thread = new Thread(delegate()
            {
                while (true)
                {
                    try
                    {
                        using (var pipe = new NamedPipeServerStream(PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.None))
                        {
                            pipe.WaitForConnection();
                            using (var reader = new StreamReader(pipe))
                            {
                                string line = reader.ReadLine();
                                if (line != null && line.Trim() == "open")
                                {
                                    try { onOpen(); } catch (Exception ex) { Log("PipeOpen", ex); }
                                }
                            }
                        }
                    }
                    catch
                    {
                        Thread.Sleep(300);
                    }
                }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        private static bool TrySendOpenCommandToRunningInstance()
        {
            try
            {
                using (var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                {
                    client.Connect(1500);
                    using (var writer = new StreamWriter(client))
                    {
                        writer.AutoFlush = true;
                        writer.WriteLine("open");
                    }
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        // ---------- 数据目录 / 端口 / 日志（多级兜底） ----------
        private static string DataDir
        {
            get
            {
                if (_dataDir != null) return _dataDir;
                var candidates = DataDirCandidates();
                foreach (var dir in candidates)
                {
                    try
                    {
                        Directory.CreateDirectory(dir);
                        _dataDir = dir;
                        return _dataDir;
                    }
                    catch
                    {
                        // 尝试下一个目录
                    }
                }
                _dataDir = candidates[0];
                return _dataDir;
            }
        }

        private static List<string> DataDirCandidates()
        {
            var list = new List<string>();
            try
            {
                list.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Reader"));
            }
            catch { }
            try
            {
                list.Add(Path.Combine(Path.GetTempPath(), "Reader"));
            }
            catch { }
            try
            {
                var exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                if (!string.IsNullOrEmpty(exeDir)) list.Add(Path.Combine(exeDir, "Reader-data"));
            }
            catch { }
            list.Add(Path.Combine(Environment.CurrentDirectory, "Reader-data"));
            return list;
        }

        private static string PortFilePath
        {
            get { return Path.Combine(DataDir, "port.txt"); }
        }

        private static int ReadPortFile()
        {
            foreach (var dir in DataDirCandidates())
            {
                try
                {
                    var file = Path.Combine(dir, "port.txt");
                    if (!File.Exists(file)) continue;
                    int port;
                    if (int.TryParse(File.ReadAllText(file).Trim(), out port) && port > 0) return port;
                }
                catch { }
            }
            return 0;
        }

        private static void WritePortFile(int port)
        {
            try
            {
                File.WriteAllText(PortFilePath, port.ToString());
            }
            catch (Exception ex)
            {
                Log("WritePortFile", ex);
            }
        }

        internal static void Log(string scope, Exception ex)
        {
            try
            {
                var line = string.Format(
                    "[{0:yyyy-MM-dd HH:mm:ss}] {1}: {2}\r\n",
                    DateTime.Now, scope, ex == null ? "(null)" : ex.ToString());
                File.AppendAllText(Path.Combine(DataDir, "launcher.log"), line, Encoding.UTF8);
            }
            catch
            {
                // 日志失败不影响主流程
            }
        }
    }

    /// <summary>
    /// 应用上下文：主窗口 + 托盘图标；退出时停止服务器。
    /// </summary>
    internal sealed class AppContext : ApplicationContext
    {
        private readonly StaticServer _server;
        private readonly int _port;
        private readonly LauncherForm _form;
        private readonly NotifyIcon _tray;

        public AppContext(StaticServer server, int port, bool autoOpenBrowser)
        {
            _server = server;
            _port = port;
            _form = new LauncherForm(port);
            _form.ExitRequested += delegate { ExitThread(); };
            _form.FormClosed += delegate { ExitThread(); };

            _tray = CreateTray();
            // Shown fires when the form is created; BeginInvoke lets the message loop start.
            _form.Shown += delegate
            {
                if (autoOpenBrowser) _form.BeginInvoke((MethodInvoker)delegate { _form.StartAutoOpenBrowser(); });
                else _form.MarkReady();
            };
            _form.Show();
        }

        private NotifyIcon CreateTray()
        {
            try
            {
                var menu = new ContextMenuStrip();
                menu.Items.Add("打开阅读器", null, delegate { OpenBrowserFromOtherInstance(); });
                menu.Items.Add("显示窗口", null, delegate { ShowForm(); });
                menu.Items.Add("复制访问地址", null, delegate
                {
                    try { Clipboard.SetText(Program.UrlForPort(_port)); } catch { }
                });
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("退出 Reader", null, delegate { ExitThread(); });

                var tray = new NotifyIcon();
                tray.Icon = LauncherForm.LoadAppIcon();
                tray.Text = "Reader v0.0.6 · " + Program.UrlForPort(_port);
                tray.ContextMenuStrip = menu;
                tray.Visible = true;
                tray.DoubleClick += delegate { OpenBrowserFromOtherInstance(); };
                return tray;
            }
            catch (Exception ex)
            {
                Program.Log("CreateTray", ex);
                return null;
            }
        }

        public void OpenBrowserFromOtherInstance()
        {
            try
            {
                if (_form.IsDisposed || !_form.IsHandleCreated) return;
                if (_form.InvokeRequired)
                {
                    _form.BeginInvoke((MethodInvoker)delegate { OpenBrowserFromOtherInstance(); });
                    return;
                }
                if (_form.WindowState == FormWindowState.Minimized) _form.WindowState = FormWindowState.Normal;
                _form.Show();
                _form.Activate();
                _form.OpenBrowserAsync();
            }
            catch (Exception ex)
            {
                Program.Log("OpenBrowserFromOtherInstance", ex);
            }
        }

        private void ShowForm()
        {
            try
            {
                if (_form.WindowState == FormWindowState.Minimized) _form.WindowState = FormWindowState.Normal;
                _form.Show();
                _form.Activate();
                _form.BringToFront();
            }
            catch { }
        }

        protected override void ExitThreadCore()
        {
            try
            {
                if (_tray != null)
                {
                    _tray.Visible = false;
                    _tray.Dispose();
                }
            }
            catch { }
            if (_server != null) _server.Stop();
            base.ExitThreadCore();
        }
    }

    /// <summary>
    /// 可见的启动状态窗口：显示地址与操作按钮，保证双击后一定有反馈。
    /// </summary>
    internal sealed class LauncherForm : Form
    {
        private readonly int _port;
        private readonly Label _status;
        private readonly Button _openButton;
        private readonly Button _copyButton;
        private readonly LinkLabel _urlLink;
        private readonly System.Windows.Forms.Timer _timeoutTimer;
        private readonly System.Windows.Forms.Timer _autoMinimizeTimer;
        private int _openGeneration;

        public event EventHandler ExitRequested;

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int enabled = 1;
                int result = DwmSetWindowAttribute(this.Handle, 20, ref enabled, sizeof(int));
                if (result != 0)
                {
                    DwmSetWindowAttribute(this.Handle, 19, ref enabled, sizeof(int));
                }
            }
            catch
            {
                // 非 Windows 11 / 无 DWM 时保持系统默认标题栏
            }
        }

        public LauncherForm(int port)
        {
            _port = port;
            Text = "Reader";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(440, 214);
            BackColor = Color.FromArgb(15, 23, 42);
            ForeColor = Color.FromArgb(226, 232, 240);
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular, GraphicsUnit.Point);
            Icon = LoadAppIcon();

            var iconBox = new PictureBox();
            iconBox.Location = new Point(22, 20);
            iconBox.Size = new Size(52, 52);
            iconBox.SizeMode = PictureBoxSizeMode.Zoom;
            try
            {
                using (var icon = LoadAppIcon())
                {
                    iconBox.Image = icon.ToBitmap();
                }
            }
            catch { }
            Controls.Add(iconBox);

            var title = new Label();
            title.Text = "Reader";
            title.Font = new Font("Segoe UI Semibold", 16f, FontStyle.Bold, GraphicsUnit.Point);
            title.ForeColor = Color.White;
            title.AutoSize = true;
            title.Location = new Point(86, 18);
            Controls.Add(title);

            var subtitle = new Label();
            subtitle.Text = port == Program.DefaultPort
                ? "本地阅读服务已启动"
                : "端口被占用，改用 " + port;
            subtitle.ForeColor = Color.FromArgb(148, 163, 184);
            subtitle.AutoSize = true;
            subtitle.Location = new Point(88, 48);
            Controls.Add(subtitle);

            _urlLink = new LinkLabel();
            _urlLink.Text = Program.UrlForPort(port);
            _urlLink.LinkColor = Color.FromArgb(56, 189, 248);
            _urlLink.ActiveLinkColor = Color.FromArgb(125, 211, 252);
            _urlLink.VisitedLinkColor = Color.FromArgb(56, 189, 248);
            _urlLink.Font = new Font("Segoe UI", 10.5f, FontStyle.Regular, GraphicsUnit.Point);
            _urlLink.AutoSize = true;
            _urlLink.Location = new Point(24, 84);
            _urlLink.LinkClicked += delegate { OpenBrowserAsync(); };
            Controls.Add(_urlLink);

            _openButton = MakeButton("打开阅读器", Color.FromArgb(56, 189, 248), Color.FromArgb(15, 23, 42), new Point(24, 116), new Size(126, 34));
            _openButton.Click += delegate { OpenBrowserAsync(); };
            Controls.Add(_openButton);

            _copyButton = MakeButton("复制地址", Color.FromArgb(30, 41, 59), Color.FromArgb(226, 232, 240), new Point(160, 116), new Size(104, 34));
            _copyButton.Click += delegate
            {
                try
                {
                    Clipboard.SetText(Program.UrlForPort(_port));
                    SetStatus("地址已复制到剪贴板。", false);
                }
                catch (Exception ex)
                {
                    SetStatus("复制失败：" + ex.Message, true);
                }
            };
            Controls.Add(_copyButton);

            var exitButton = MakeButton("退出", Color.FromArgb(30, 41, 59), Color.FromArgb(226, 232, 240), new Point(274, 116), new Size(78, 34));
            exitButton.Click += delegate { OnExitRequested(); };
            Controls.Add(exitButton);

            _status = new Label();
            _status.AutoSize = false;
            _status.Size = new Size(392, 40);
            _status.Location = new Point(24, 162);
            _status.ForeColor = Color.FromArgb(148, 163, 184);
            _status.Text = "正在启动本地服务…";
            _status.UseCompatibleTextRendering = true;
            Controls.Add(_status);

            _timeoutTimer = new System.Windows.Forms.Timer();
            _timeoutTimer.Interval = 9000;
            _timeoutTimer.Tick += delegate
            {
                _timeoutTimer.Stop();
                if (_status.Text.IndexOf("正在打开浏览器", StringComparison.Ordinal) >= 0)
                {
                    SetStatus("未能自动打开浏览器，请点击上方地址或「打开阅读器」。", true);
                }
            };

            _autoMinimizeTimer = new System.Windows.Forms.Timer();
            _autoMinimizeTimer.Interval = 5000;
            _autoMinimizeTimer.Tick += delegate
            {
                _autoMinimizeTimer.Stop();
                if (WindowState == FormWindowState.Normal && ActiveForm == null)
                {
                    WindowState = FormWindowState.Minimized;
                }
            };
        }

        private static Button MakeButton(string text, Color backColor, Color foreColor, Point location, Size size)
        {
            var button = new Button();
            button.Text = text;
            button.Location = location;
            button.Size = size;
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 0;
            button.BackColor = backColor;
            button.ForeColor = foreColor;
            button.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold, GraphicsUnit.Point);
            button.Cursor = Cursors.Hand;
            return button;
        }

        internal static Icon LoadAppIcon()
        {
            try
            {
                var icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (icon != null) return icon;
            }
            catch { }
            return SystemIcons.Application;
        }

        public void StartAutoOpenBrowser()
        {
            SetStatus("正在打开浏览器…", false);
            _timeoutTimer.Start();
            OpenBrowserAsync();
        }

        public void MarkReady()
        {
            SetStatus("本地服务已启动，可点击上方地址或「打开阅读器」。", false);
        }

        public void OpenBrowserAsync()
        {
            // UI event callbacks run on the STA thread. Delay one message so UI repaints.
            SetStatus("正在打开浏览器…", false);
            _timeoutTimer.Stop();
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    try
                    {
                        Program.OpenBrowser(Program.UrlForPort(_port));
                        SetStatus("已向 Windows 发出浏览器启动请求。如未打开，请检查默认浏览器设置。", false);
                    }
                    catch (Exception ex)
                    {
                        Program.Log("OpenBrowser", ex);
                        SetStatus("无法打开浏览器：" + ex.Message, true);
                    }
                });
            }
            catch (Exception ex)
            {
                Program.Log("ScheduleBrowser", ex);
                SetStatus("无法启动浏览器：" + ex.Message, true);
            }
        }

        private void SetStatus(string text, bool error)
        {
            _status.Text = text;
            _status.ForeColor = error ? Color.FromArgb(248, 113, 113) : Color.FromArgb(148, 163, 184);
        }

        private void OnExitRequested()
        {
            var handler = ExitRequested;
            if (handler != null) handler(this, EventArgs.Empty);
        }
    }

    /// <summary>
    /// 极简静态 HTTP 服务：只处理 GET/HEAD，只监听本机回环地址。
    /// </summary>
    internal sealed class StaticServer
    {
        private readonly Dictionary<string, string> _resourceByUrl =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        private readonly List<TcpListener> _listeners = new List<TcpListener>();
        private readonly ManualResetEvent _stopEvent = new ManualResetEvent(false);
        private volatile bool _running;
        private int _port;

        public int Port { get { return _port; } }

        public int Start(int firstPort, int attempts)
        {
            LoadEmbeddedAssets();
            for (int i = 0; i < attempts; i++)
            {
                int port = firstPort + i;
                if (port > 65535) break;
                try
                {
                    Bind(port);
                    _port = port;
                    _running = true;
                    foreach (var listener in _listeners)
                    {
                        var captured = listener;
                        var thread = new Thread(() => AcceptLoop(captured));
                        thread.IsBackground = true;
                        thread.Start();
                    }
                    return port;
                }
                catch (SocketException)
                {
                    StopListenersOnly();
                }
            }
            throw new InvalidOperationException(
                "无法在 " + firstPort + " 起始的 " + attempts + " 个端口上启动本地服务（端口可能被其它程序占用）。");
        }

        private void Bind(int port)
        {
            var ipv4 = new TcpListener(IPAddress.Loopback, port);
            ipv4.Start();
            _listeners.Add(ipv4);

            try
            {
                var ipv6 = new TcpListener(IPAddress.IPv6Loopback, port);
                ipv6.Start();
                _listeners.Add(ipv6);
            }
            catch (SocketException)
            {
                // 某些系统禁用 IPv6 回环，只保留 IPv4
            }
        }

        private void StopListenersOnly()
        {
            foreach (var listener in _listeners)
            {
                try { listener.Stop(); } catch { }
            }
            _listeners.Clear();
        }

        public void Stop()
        {
            _running = false;
            _stopEvent.Set();
            StopListenersOnly();
        }

        public void WaitForExit()
        {
            _stopEvent.WaitOne();
        }

        private void AcceptLoop(TcpListener listener)
        {
            while (_running)
            {
                TcpClient client = null;
                try
                {
                    client = listener.AcceptTcpClient();
                }
                catch (SocketException) { break; }
                catch (ObjectDisposedException) { break; }
                catch (Exception ex)
                {
                    Program.Log("Accept", ex);
                    break;
                }

                var captured = client;
                ThreadPool.QueueUserWorkItem(delegate { HandleClient(captured); });
            }
        }

        private void HandleClient(TcpClient client)
        {
            try
            {
                using (client)
                {
                    client.ReceiveTimeout = 5000;
                    using (var stream = client.GetStream())
                    {
                        stream.ReadTimeout = 5000;
                        stream.WriteTimeout = 5000;

                        var request = ReadRequestHead(stream);
                        if (request == null)
                        {
                            WriteResponse(stream, 400, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Bad Request"), false);
                            return;
                        }

                        var parts = request.Split(' ');
                        if (parts.Length < 2)
                        {
                            WriteResponse(stream, 400, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Bad Request"), false);
                            return;
                        }

                        string method = parts[0].ToUpperInvariant();
                        bool isHead = method == "HEAD";
                        if (method != "GET" && !isHead)
                        {
                            WriteResponse(stream, 405, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Method Not Allowed"), false);
                            return;
                        }

                        string url = parts[1];
                        int query = url.IndexOf('?');
                        if (query >= 0) url = url.Substring(0, query);

                        string path = NormalizePath(url);
                        if (path == null)
                        {
                            WriteResponse(stream, 403, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Forbidden"), isHead);
                            return;
                        }

                        if (path == "favicon.ico")
                        {
                            var favicon = ReadEmbeddedResource("reader.favicon");
                            if (favicon != null)
                            {
                                WriteResponse(stream, 200, "image/x-icon", favicon, isHead);
                            }
                            else
                            {
                                WriteResponse(stream, 404, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Favicon Not Found"), isHead);
                            }
                            return;
                        }

                        byte[] body;
                        string resourceName;
                        if (TryResolve(path, out body, out resourceName))
                        {
                            WriteResponse(stream, 200, ContentTypeFor(path), body, isHead);
                        }
                        else
                        {
                            var notFound = Encoding.UTF8.GetBytes("404 Not Found: " + path);
                            WriteResponse(stream, 404, "text/plain; charset=utf-8", notFound, isHead);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Program.Log("HandleClient", ex);
            }
        }

        private static string ReadRequestHead(Stream stream)
        {
            var buffer = new byte[8192];
            var builder = new StringBuilder();
            int total = 0;
            while (total < 16384)
            {
                int read = stream.Read(buffer, 0, Math.Min(buffer.Length, 16384 - total));
                if (read <= 0) break;
                total += read;
                builder.Append(Encoding.ASCII.GetString(buffer, 0, read));
                if (builder.ToString().IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0) break;
                if (builder.ToString().IndexOf("\n\n", StringComparison.Ordinal) >= 0) break;
            }
            var text = builder.ToString();
            int end = text.IndexOf("\r\n", StringComparison.Ordinal);
            if (end < 0) end = text.IndexOf('\n');
            if (end < 0) return null;
            return text.Substring(0, end).Trim();
        }

        private static string NormalizePath(string url)
        {
            try
            {
                string path = Uri.UnescapeDataString(url);
                path = path.Replace('\\', '/');
                while (path.StartsWith("/", StringComparison.Ordinal)) path = path.Substring(1);
                if (path.Length == 0) path = "index.html";
                if (path.EndsWith("/", StringComparison.Ordinal)) path += "index.html";
                if (path.IndexOf("..", StringComparison.Ordinal) >= 0) return null;
                if (path.IndexOf('\0') >= 0) return null;
                return path;
            }
            catch
            {
                return null;
            }
        }

        private bool TryResolve(string path, out byte[] body, out string resourceName)
        {
            body = null;
            resourceName = null;

            if (_resourceByUrl.TryGetValue(path, out resourceName))
            {
                body = ReadEmbeddedResource(resourceName);
                if (body != null) return true;
            }

            try
            {
                var baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? ".";
                var full = Path.GetFullPath(Path.Combine(baseDir, path.Replace('/', Path.DirectorySeparatorChar)));
                var baseFull = Path.GetFullPath(baseDir);
                if ((string.Equals(full, baseFull, StringComparison.OrdinalIgnoreCase) ||
                     full.StartsWith(baseFull.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    && File.Exists(full))
                {
                    body = File.ReadAllBytes(full);
                    return true;
                }
            }
            catch { }
            return false;
        }

        private static byte[] ReadEmbeddedResource(string name)
        {
            try
            {
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                {
                    if (stream == null) return null;
                    using (var memory = new MemoryStream())
                    {
                        stream.CopyTo(memory);
                        return memory.ToArray();
                    }
                }
            }
            catch
            {
                return null;
            }
        }

        private void LoadEmbeddedAssets()
        {
            var mapBytes = ReadEmbeddedResource("assets.map");
            if (mapBytes == null) return;
            var text = Encoding.UTF8.GetString(mapBytes);
            foreach (var rawLine in text.Split('\n'))
            {
                var line = rawLine.Trim();
                if (line.Length == 0) continue;
                int split = line.IndexOf('|');
                if (split <= 0) continue;
                var url = line.Substring(0, split);
                var resource = line.Substring(split + 1);
                _resourceByUrl[url] = resource;
            }
        }

        private static string ContentTypeFor(string path)
        {
            var ext = Path.GetExtension(path).ToLowerInvariant();
            switch (ext)
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".md": return "text/markdown; charset=utf-8";
                case ".txt": return "text/plain; charset=utf-8";
                case ".pdf": return "application/pdf";
                case ".png": return "image/png";
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".webp": return "image/webp";
                case ".svg": return "image/svg+xml";
                case ".ico": return "image/x-icon";
                default: return "application/octet-stream";
            }
        }

        private static void WriteResponse(Stream stream, int status, string contentType, byte[] body, bool headOnly)
        {
            var reason = "OK";
            if (status == 204) reason = "No Content";
            else if (status == 400) reason = "Bad Request";
            else if (status == 403) reason = "Forbidden";
            else if (status == 404) reason = "Not Found";
            else if (status == 405) reason = "Method Not Allowed";

            var header = new StringBuilder();
            header.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
            header.Append("Content-Type: ").Append(contentType).Append("\r\n");
            if (status != 204) header.Append("Content-Length: ").Append(body.Length).Append("\r\n");
            header.Append("Cache-Control: no-store\r\n");
            header.Append("X-Content-Type-Options: nosniff\r\n");
            header.Append("Connection: close\r\n\r\n");

            var head = Encoding.ASCII.GetBytes(header.ToString());
            stream.Write(head, 0, head.Length);
            if (!headOnly && status != 204 && body.Length > 0)
            {
                stream.Write(body, 0, body.Length);
            }
            stream.Flush();
        }
    }
}
