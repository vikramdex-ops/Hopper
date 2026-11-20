// HopperShell.exe --hooks : the Windows side of Hopper Clipboard (src/main/clipboard.ts).
//  - AddClipboardFormatListener: every clipboard change is reported with its file list (for files
//    and folders), whether it was a Cut, the program that copied it, and whether the copying program
//    asked to be left out of clipboard history (password managers do).
//  - WH_KEYBOARD_LL: Win+V is taken (Windows registers it for its own clipboard, so RegisterHotKey
//    cannot have it) and reported with the window that was in front, so a pick can be pasted there.
// Out, one JSON object per line: {"ev":"ready"}, {"ev":"clip",...}, {"ev":"winv","hwnd":N}
// In, one command per line: "winv 1" / "winv 0" (take Win+V or leave it to Windows), "paste N"
// (bring window N to the front and press Ctrl+V). Exits when stdin closes.
// C# 5 (the .NET Framework csc that ships with Windows): no ?. or $"" here.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Hopper
{
    static class Hooks
    {
        const int WH_KEYBOARD_LL = 13;
        const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
        const int WM_CLIPBOARDUPDATE = 0x031D;
        const int VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RWIN = 0x5C, VK_V = 0x56;
        // an unassigned virtual key: pressed after a swallowed Win+V so releasing Win does not open Start
        const byte VK_DUMMY = 0xE8;
        const uint KEYEVENTF_KEYUP = 2;
        const uint LLKHF_INJECTED = 0x10;

        delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }

        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, LowLevelProc fn, IntPtr mod, uint thread);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool AddClipboardFormatListener(IntPtr h);
        [DllImport("user32.dll")] static extern bool RemoveClipboardFormatListener(IntPtr h);
        [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
        [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint f);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        static readonly BlockingCollection<string> Out = new BlockingCollection<string>();
        static LowLevelProc hookProc; // kept alive: the GC must never collect the delegate Windows calls
        static IntPtr hook = IntPtr.Zero;
        static volatile bool takeWinV = false;
        static bool swallowing = false;
        static HookWin win;
        static uint fmtExclude, fmtIgnore, fmtCanInclude;

        sealed class HookWin : Control
        {
            readonly System.Windows.Forms.Timer settle = new System.Windows.Forms.Timer { Interval = 120 };
            public HookWin() { settle.Tick += delegate { settle.Stop(); ReportClip(); }; }
            protected override CreateParams CreateParams
            {
                get { var cp = base.CreateParams; cp.Parent = new IntPtr(-3); return cp; } // HWND_MESSAGE
            }
            protected override void WndProc(ref Message m)
            {
                // programs often set several formats in a row: report once things settle
                if (m.Msg == WM_CLIPBOARDUPDATE) { settle.Stop(); settle.Start(); }
                base.WndProc(ref m);
            }
        }

        public static int Run()
        {
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            var writer = new Thread(delegate ()
            {
                foreach (var line in Out.GetConsumingEnumerable())
                {
                    try { stdout.Write(line); stdout.Write('\n'); stdout.Flush(); }
                    catch { Environment.Exit(0); }
                }
            });
            writer.IsBackground = true;
            writer.Start();

            fmtExclude = RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing");
            fmtIgnore = RegisterClipboardFormat("Clipboard Viewer Ignore");
            fmtCanInclude = RegisterClipboardFormat("CanIncludeInClipboardHistory");

            win = new HookWin();
            win.CreateControl();
            var h = win.Handle;
            AddClipboardFormatListener(h);
            hookProc = KeyHook;
            hook = SetWindowsHookEx(WH_KEYBOARD_LL, hookProc, GetModuleHandle(null), 0);

            var reader = new Thread(delegate ()
            {
                var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                try
                {
                    while ((line = stdin.ReadLine()) != null) Command(line.Trim());
                }
                catch { }
                try { win.BeginInvoke((MethodInvoker)delegate { Application.ExitThread(); }); } catch { Environment.Exit(0); }
            });
            reader.IsBackground = true;
            reader.Start();

            Emit("{\"ev\":\"ready\",\"hook\":" + (hook != IntPtr.Zero ? "true" : "false") + "}");
            // memory diet: this process lives all day; keep only what the hook and listener touch
            var trim = new System.Windows.Forms.Timer { Interval = 60000 };
            trim.Tick += delegate { Program.Trim(); };
            trim.Start();
            win.BeginInvoke((MethodInvoker)delegate { Program.Trim(); });
            Application.Run();
            if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
            RemoveClipboardFormatListener(h);
            Out.CompleteAdding();
            return 0;
        }

        static void Emit(string json) { try { Out.Add(json); } catch { } }

        static void Command(string line)
        {
            if (line == "winv 1") takeWinV = true;
            else if (line == "winv 0") takeWinV = false;
            else if (line.StartsWith("paste ", StringComparison.Ordinal))
            {
                long v;
                if (!long.TryParse(line.Substring(6), out v)) return;
                var target = new IntPtr(v);
                win.BeginInvoke((MethodInvoker)delegate { Paste(target); });
            }
        }

        static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

        static IntPtr KeyHook(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                int msg = wParam.ToInt32();
                bool injected = (k.flags & LLKHF_INJECTED) != 0;
                if (k.vkCode == VK_V && !injected)
                {
                    if ((msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) && takeWinV && (Down(VK_LWIN) || Down(VK_RWIN)) && !Down(VK_CONTROL) && !Down(VK_MENU) && !Down(VK_SHIFT))
                    {
                        if (!swallowing)
                        {
                            swallowing = true;
                            // releasing Win after a swallowed key would open Start: press a key nobody uses
                            keybd_event(VK_DUMMY, 0, 0, UIntPtr.Zero);
                            keybd_event(VK_DUMMY, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                            Emit("{\"ev\":\"winv\",\"hwnd\":" + GetForegroundWindow().ToInt64() + "}");
                        }
                        return new IntPtr(1);
                    }
                    if ((msg == WM_KEYUP || msg == WM_SYSKEYUP) && swallowing)
                    {
                        swallowing = false;
                        return new IntPtr(1);
                    }
                }
            }
            return CallNextHookEx(hook, nCode, wParam, lParam);
        }

        static void ReportClip()
        {
            var d = new Dictionary<string, object>();
            d["ev"] = "clip";
            d["seq"] = GetClipboardSequenceNumber();
            bool priv = IsClipboardFormatAvailable(fmtExclude) || IsClipboardFormatAvailable(fmtIgnore);
            var files = new List<object>();
            bool cut = false;
            for (int attempt = 0; attempt < 4; attempt++)
            {
                try
                {
                    if (!priv && IsClipboardFormatAvailable(fmtCanInclude))
                    {
                        var s = Clipboard.GetData("CanIncludeInClipboardHistory") as MemoryStream;
                        if (s != null && s.Length >= 4) { var b = new byte[4]; s.Read(b, 0, 4); if (BitConverter.ToInt32(b, 0) == 0) priv = true; }
                    }
                    if (!priv && Clipboard.ContainsFileDropList())
                    {
                        foreach (var p in Clipboard.GetFileDropList())
                        {
                            var f = new Dictionary<string, object>();
                            f["path"] = p;
                            f["dir"] = Directory.Exists(p);
                            files.Add(f);
                            if (files.Count >= 5000) break;
                        }
                        var effect = Clipboard.GetData("Preferred DropEffect") as MemoryStream;
                        if (effect != null && effect.Length >= 4) { var b = new byte[4]; effect.Read(b, 0, 4); cut = (BitConverter.ToInt32(b, 0) & 2) != 0; }
                    }
                    break;
                }
                catch (ExternalException) { Thread.Sleep(60); } // clipboard held open by the copying program
                catch { break; }
            }
            d["private"] = priv;
            d["files"] = files;
            d["cut"] = cut;
            d["app"] = ProcessName(GetClipboardOwner());
            if ((string)d["app"] == "") d["app"] = ProcessName(GetForegroundWindow());
            Emit(Json.Serialize(d));
        }

        static string ProcessName(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return "";
            try
            {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid == 0) return "";
                using (var p = Process.GetProcessById((int)pid)) return p.ProcessName;
            }
            catch { return ""; }
        }

        /** Bring the window the user was in back to the front and press Ctrl+V there. */
        static void Paste(IntPtr target)
        {
            if (target != IntPtr.Zero && IsWindow(target) && GetForegroundWindow() != target)
            {
                uint pid;
                uint other = GetWindowThreadProcessId(target, out pid);
                uint me = GetCurrentThreadId();
                // a background process may not take the foreground; a key event and attached input allow it
                keybd_event((byte)VK_MENU, 0, 0, UIntPtr.Zero);
                keybd_event((byte)VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                bool attached = other != 0 && other != me && AttachThreadInput(me, other, true);
                BringWindowToTop(target);
                SetForegroundWindow(target);
                if (attached) AttachThreadInput(me, other, false);
                Thread.Sleep(80);
            }
            // never paste while the user still holds Win / Shift / Alt from the shortcut
            for (int i = 0; i < 40 && (Down(VK_LWIN) || Down(VK_RWIN) || Down(VK_SHIFT) || Down(VK_MENU)); i++) Thread.Sleep(25);
            keybd_event((byte)VK_CONTROL, 0, 0, UIntPtr.Zero);
            keybd_event((byte)VK_V, 0, 0, UIntPtr.Zero);
            keybd_event((byte)VK_V, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            keybd_event((byte)VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        }
    }
}
