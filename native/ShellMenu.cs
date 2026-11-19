// "More options": the real Windows shell context menu for files or a folder background, so
// shell extensions (7-Zip, TortoiseGit, Send to, Open with...) work from Hopper.
// Runs on the helper's UI thread (STA with a message loop). The helper is not the foreground
// process, so it takes the foreground for the menu and hands it back when the menu closes.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Hopper
{
    static class ShellMenu
    {
        [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellFolder
        {
            [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr pchEaten, out IntPtr ppidl, IntPtr pdwAttributes);
            [PreserveSig] int EnumObjects(IntPtr hwnd, int flags, out IntPtr ppenum);
            [PreserveSig] int BindToObject(IntPtr pidl, IntPtr pbc, [In] ref Guid riid, out IntPtr ppv);
            [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr pbc, [In] ref Guid riid, out IntPtr ppv);
            [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr pidl1, IntPtr pidl2);
            [PreserveSig] int CreateViewObject(IntPtr hwndOwner, [In] ref Guid riid, out IntPtr ppv);
            [PreserveSig] int GetAttributesOf(uint cidl, IntPtr apidl, ref uint rgfInOut);
            [PreserveSig] int GetUIObjectOf(IntPtr hwndOwner, uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, [In] ref Guid riid, IntPtr rgfReserved, out IntPtr ppv);
            [PreserveSig] int GetDisplayNameOf(IntPtr pidl, uint flags, IntPtr pName);
            [PreserveSig] int SetNameOf(IntPtr hwnd, IntPtr pidl, [MarshalAs(UnmanagedType.LPWStr)] string name, uint flags, out IntPtr ppidlOut);
        }

        [ComImport, Guid("000214E4-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IContextMenu
        {
            [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
            [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX pici);
            [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, IntPtr pszName, uint cchMax);
        }

        [ComImport, Guid("000214F4-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IContextMenu2
        {
            [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
            [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX pici);
            [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, IntPtr pszName, uint cchMax);
            [PreserveSig] int HandleMenuMsg(uint uMsg, IntPtr wParam, IntPtr lParam);
        }

        [ComImport, Guid("BCFCE0A0-EC17-11D0-8D10-00A0C90F2719"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IContextMenu3
        {
            [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
            [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX pici);
            [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, IntPtr pszName, uint cchMax);
            [PreserveSig] int HandleMenuMsg(uint uMsg, IntPtr wParam, IntPtr lParam);
            [PreserveSig] int HandleMenuMsg2(uint uMsg, IntPtr wParam, IntPtr lParam, out IntPtr plResult);
        }

        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        struct CMINVOKECOMMANDINFOEX
        {
            public int cbSize;
            public int fMask;
            public IntPtr hwnd;
            public IntPtr lpVerb;
            public IntPtr lpParameters;
            public IntPtr lpDirectory;
            public int nShow;
            public int dwHotKey;
            public IntPtr hIcon;
            public IntPtr lpTitle;
            public IntPtr lpVerbW;
            public IntPtr lpParametersW;
            public IntPtr lpDirectoryW;
            public IntPtr lpTitleW;
            public POINT ptInvoke;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHParseDisplayName(string name, IntPtr bc, out IntPtr pidl, uint sfgaoIn, out uint psfgaoOut);
        [DllImport("shell32.dll")]
        static extern int SHBindToParent(IntPtr pidl, [In] ref Guid riid, out IntPtr ppv, out IntPtr ppidlLast);
        [DllImport("shell32.dll")]
        static extern int SHGetDesktopFolder(out IntPtr ppshf);
        [DllImport("shell32.dll")]
        static extern IntPtr ILFindLastID(IntPtr pidl);

        [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
        [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr hmenu);
        [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr hmenu);
        [DllImport("user32.dll")] static extern int TrackPopupMenuEx(IntPtr hmenu, uint flags, int x, int y, IntPtr hwnd, IntPtr tpm);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT pt);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

        const uint CMF_NORMAL = 0x0, CMF_EXPLORE = 0x4, CMF_EXTENDEDVERBS = 0x100;
        const uint TPM_RIGHTBUTTON = 0x2, TPM_RETURNCMD = 0x100;
        const int CMIC_MASK_UNICODE = 0x4000, CMIC_MASK_SHIFT_DOWN = 0x10000000, CMIC_MASK_PTINVOKE = 0x20000000;
        const int SW_SHOWNORMAL = 1;
        const uint WM_NULL = 0;
        const int WM_DRAWITEM = 0x2B, WM_MEASUREITEM = 0x2C, WM_INITMENUPOPUP = 0x117, WM_MENUCHAR = 0x120;
        const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
        const uint GCS_VERBW = 4;
        const int ERROR_CANCELLED_HR = unchecked((int)0x800704C7);
        const uint ID_FIRST = 1, ID_LAST = 0x7FFF;

        static readonly Guid IID_IShellFolder = new Guid("000214E6-0000-0000-C000-000000000046");
        static readonly Guid IID_IContextMenu = new Guid("000214E4-0000-0000-C000-000000000046");

        /// <summary>A hidden top-level window that owns the menu and forwards owner-draw and submenu
        /// messages to the handler, so "Send to" and "Open with" fill in.</summary>
        class MenuHost : NativeWindow
        {
            public IContextMenu2 cm2;
            public IContextMenu3 cm3;

            protected override void WndProc(ref Message m)
            {
                if (cm2 != null || cm3 != null)
                {
                    switch (m.Msg)
                    {
                        case WM_INITMENUPOPUP:
                        case WM_DRAWITEM:
                        case WM_MEASUREITEM:
                        case WM_MENUCHAR:
                            try
                            {
                                if (cm3 != null)
                                {
                                    IntPtr r;
                                    if (cm3.HandleMenuMsg2((uint)m.Msg, m.WParam, m.LParam, out r) == 0) { m.Result = r; return; }
                                }
                                else if (m.Msg != WM_MENUCHAR && cm2.HandleMenuMsg((uint)m.Msg, m.WParam, m.LParam) == 0)
                                {
                                    m.Result = m.Msg == WM_INITMENUPOPUP ? IntPtr.Zero : new IntPtr(1);
                                    return;
                                }
                            }
                            catch { /* a broken extension must not take the helper down */ }
                            break;
                    }
                }
                try { base.WndProc(ref m); } catch { }
            }
        }

        static MenuHost host;
        static bool busy;

        static string Parent(string p)
        {
            string t = p.TrimEnd('\\', '/');
            string d = null;
            try { d = Path.GetDirectoryName(t); } catch { }
            return (d ?? "").TrimEnd('\\').ToLowerInvariant();
        }

        /// <summary>Checks the request before anything touches the UI thread (runs on the caller's thread).</summary>
        public static void Validate(List<string> paths, string folder)
        {
            if (paths.Count == 0 && string.IsNullOrEmpty(folder)) throw new Exception("Nothing to show a menu for.");
            if (paths.Count > 0)
            {
                string parent = Parent(paths[0]);
                foreach (var p in paths)
                {
                    if (string.IsNullOrEmpty(p) || !(File.Exists(p) || Directory.Exists(p))) throw new Exception("Can't find " + p);
                    if (Parent(p) != parent) throw new Exception("The selected items are in different folders.");
                }
            }
            else if (!Directory.Exists(folder)) throw new Exception("Can't find " + folder);
        }

        static IntPtr Pidl(string path)
        {
            IntPtr pidl; uint attrs;
            int hr = SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out attrs);
            if (hr != 0 || pidl == IntPtr.Zero) throw new Exception("Can't find " + path + " (0x" + hr.ToString("x8") + ")");
            return pidl;
        }

        static void Release(object o) { if (o != null) { try { Marshal.ReleaseComObject(o); } catch { } } }

        /// <summary>The menu for the items (all in one folder), or for the folder's background when paths is empty.</summary>
        static IContextMenu Create(List<string> paths, string folder, IntPtr hwnd, List<IntPtr> pidls)
        {
            IntPtr ppv;
            if (paths.Count == 0)
            {
                IntPtr pidl = Pidl(folder);
                pidls.Add(pidl);
                IntPtr deskPtr;
                if (SHGetDesktopFolder(out deskPtr) != 0) throw new Exception("The Windows shell is not available.");
                var desk = (IShellFolder)Marshal.GetObjectForIUnknown(deskPtr);
                Marshal.Release(deskPtr);
                IShellFolder sf = desk;
                try
                {
                    if (Marshal.ReadInt16(pidl) != 0) // not the desktop itself
                    {
                        Guid iidSf = IID_IShellFolder;
                        IntPtr sfPtr;
                        int hr0 = desk.BindToObject(pidl, IntPtr.Zero, ref iidSf, out sfPtr);
                        if (hr0 != 0) throw new Exception("Can't open " + folder + " (0x" + hr0.ToString("x8") + ")");
                        sf = (IShellFolder)Marshal.GetObjectForIUnknown(sfPtr);
                        Marshal.Release(sfPtr);
                    }
                    Guid iid = IID_IContextMenu;
                    int hr = sf.CreateViewObject(hwnd, ref iid, out ppv);
                    if (hr != 0 || ppv == IntPtr.Zero) throw new Exception("Windows has no menu for " + folder + " (0x" + hr.ToString("x8") + ")");
                }
                finally
                {
                    if (!ReferenceEquals(sf, desk)) Release(sf);
                    Release(desk);
                }
            }
            else
            {
                foreach (var p in paths) pidls.Add(Pidl(p));
                Guid iidSf = IID_IShellFolder;
                IntPtr parentPtr, first;
                int hr0 = SHBindToParent(pidls[0], ref iidSf, out parentPtr, out first);
                if (hr0 != 0) throw new Exception("Can't open the folder of " + paths[0] + " (0x" + hr0.ToString("x8") + ")");
                var parent = (IShellFolder)Marshal.GetObjectForIUnknown(parentPtr);
                Marshal.Release(parentPtr);
                try
                {
                    var children = new IntPtr[pidls.Count];
                    children[0] = first;
                    for (int i = 1; i < pidls.Count; i++) children[i] = ILFindLastID(pidls[i]);
                    Guid iid = IID_IContextMenu;
                    int hr = parent.GetUIObjectOf(hwnd, (uint)children.Length, children, ref iid, IntPtr.Zero, out ppv);
                    if (hr != 0 || ppv == IntPtr.Zero) throw new Exception("Windows has no menu for these items (0x" + hr.ToString("x8") + ")");
                }
                finally { Release(parent); }
            }
            var cm = (IContextMenu)Marshal.GetObjectForIUnknown(ppv);
            Marshal.Release(ppv);
            return cm;
        }

        static string Verb(IContextMenu cm, int id)
        {
            IntPtr buf = Marshal.AllocCoTaskMem(520);
            try
            {
                Marshal.WriteInt16(buf, 0);
                if (cm.GetCommandString(new UIntPtr((uint)id), GCS_VERBW, IntPtr.Zero, buf, 260) != 0) return "";
                return Marshal.PtrToStringUni(buf) ?? "";
            }
            catch { return ""; }
            finally { Marshal.FreeCoTaskMem(buf); }
        }

        /// <summary>Shows the menu at the mouse pointer and runs what the user picks. Must run on the UI thread.
        /// -> { invoked: bool, verb?: string }</summary>
        public static Dictionary<string, object> Show(List<string> paths, string folder, bool extended, bool probe)
        {
            if (busy) throw new Exception("A Windows menu is already open.");
            busy = true;
            IntPtr oldDpi = IntPtr.Zero;
            bool dpiSet = false;
            try { oldDpi = SetThreadDpiAwarenessContext(new IntPtr(-4)); dpiSet = oldDpi != IntPtr.Zero; } // per-monitor v2: crisp menu
            catch (EntryPointNotFoundException) { }
            var pidls = new List<IntPtr>();
            IContextMenu cm = null;
            IntPtr hmenu = IntPtr.Zero;
            IntPtr fg = GetForegroundWindow();
            try
            {
                if (host == null)
                {
                    host = new MenuHost();
                    host.CreateHandle(new CreateParams());
                }
                IntPtr hwnd = host.Handle;
                POINT pt;
                GetCursorPos(out pt);
                // dialogs a command opens (Properties, confirmations) centre on the owner: put it where the user clicked
                SetWindowPos(hwnd, IntPtr.Zero, pt.X, pt.Y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);

                cm = Create(paths, folder, hwnd, pidls);
                hmenu = CreatePopupMenu();
                uint flags = CMF_NORMAL | CMF_EXPLORE | (extended ? CMF_EXTENDEDVERBS : 0);
                int qhr = cm.QueryContextMenu(hmenu, 0, ID_FIRST, ID_LAST, flags);
                if (qhr < 0) throw new Exception("Windows could not build the menu (0x" + qhr.ToString("x8") + ")");
                if (probe)
                {
                    // tests: build the menu, report its size, never show it
                    var p = new Dictionary<string, object>();
                    p["invoked"] = false;
                    p["items"] = GetMenuItemCount(hmenu);
                    return p;
                }
                host.cm3 = cm as IContextMenu3;
                host.cm2 = cm as IContextMenu2;

                // A menu only closes on an outside click when its owner is the foreground window.
                uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, IntPtr.Zero) : 0;
                uint me = GetCurrentThreadId();
                bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
                SetForegroundWindow(hwnd);
                if (attached) AttachThreadInput(me, fgThread, false);

                int cmd = TrackPopupMenuEx(hmenu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.X, pt.Y, hwnd, IntPtr.Zero);
                PostMessage(hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero);

                var result = new Dictionary<string, object>();
                result["invoked"] = false;
                if (cmd <= 0)
                {
                    if (fg != IntPtr.Zero && GetForegroundWindow() == hwnd) SetForegroundWindow(fg);
                    return result;
                }
                int id = cmd - (int)ID_FIRST;
                string verb = Verb(cm, id);
                string dir = paths.Count > 0 ? Path.GetDirectoryName(paths[0].TrimEnd('\\')) : folder;
                IntPtr dirW = string.IsNullOrEmpty(dir) ? IntPtr.Zero : Marshal.StringToHGlobalUni(dir);
                IntPtr dirA = string.IsNullOrEmpty(dir) ? IntPtr.Zero : Marshal.StringToHGlobalAnsi(dir);
                try
                {
                    var ci = new CMINVOKECOMMANDINFOEX();
                    ci.cbSize = Marshal.SizeOf(typeof(CMINVOKECOMMANDINFOEX));
                    ci.fMask = CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE | (extended ? CMIC_MASK_SHIFT_DOWN : 0);
                    ci.hwnd = hwnd;
                    ci.lpVerb = new IntPtr(id);
                    ci.lpVerbW = new IntPtr(id);
                    ci.lpDirectory = dirA;
                    ci.lpDirectoryW = dirW;
                    ci.nShow = SW_SHOWNORMAL;
                    ci.ptInvoke = pt;
                    int hr = cm.InvokeCommand(ref ci);
                    if (hr != 0 && hr != ERROR_CANCELLED_HR) throw new Exception("The command did not run (0x" + hr.ToString("x8") + ")");
                }
                finally
                {
                    if (dirW != IntPtr.Zero) Marshal.FreeHGlobal(dirW);
                    if (dirA != IntPtr.Zero) Marshal.FreeHGlobal(dirA);
                    if (fg != IntPtr.Zero && GetForegroundWindow() == hwnd) SetForegroundWindow(fg);
                }
                result["invoked"] = true;
                result["verb"] = verb;
                return result;
            }
            finally
            {
                if (host != null) { host.cm2 = null; host.cm3 = null; }
                if (hmenu != IntPtr.Zero) DestroyMenu(hmenu);
                Release(cm);
                foreach (var p in pidls) Marshal.FreeCoTaskMem(p);
                if (dpiSet) { try { SetThreadDpiAwarenessContext(oldDpi); } catch { } }
                busy = false;
            }
        }
    }
}
