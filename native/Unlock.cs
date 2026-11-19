// "Who has it open" and Unlock, native side (see docs/UNLOCK.md):
//   rmHolders {paths}               -> [{path, pid, start, app, exe, user, type, session, restartable}]
//                                      processes on THIS PC holding the files (Restart Manager; UNC and
//                                      mapped-drive paths work; folders are expanded by the caller)
//   rmShutdown {path, pid, start}   -> {ok, code}  asks ONE app to close the way Windows does at sign-out
//                                      (no force flag: the app may ask to save, or refuse)
//   explorerWindows {paths}         -> [{path, hwnd}] File Explorer windows showing a path or a folder inside it
//   explorerRelease {paths, to}     -> {moved} navigates those windows to `to` (closes them when that fails)
//   smbOpenFiles {path}             -> {ok, files:[{id, path, user, locks}]} | {ok:false, error:"needs-admin"|...}
//                                      the SMB server's own list of open files under a local path
//   smbCloseFile {id}               -> {ok, path} | {ok:false, error}  only a file open under an ordinary disk share
//   smbSessions {}                  -> {ok, sessions:[{client, user}]} who is connected from which address
//   auditLog {line}                 -> {ok, path} appends to %ProgramData%\Hopper\unlock-log.jsonl (admins only)
//   agentCall {cmd, args}           -> relays one of the commands above to the elevated agent, after checking
//                                      that the pipe is served by the agent exe in Program Files
//   elevated {}                     -> true when this process runs with administrator rights
// Every Restart Manager session is ended and every COM object released, whatever happens.
// Agent mode (HopperShell.exe --agent): on the file server, the copy in Program Files\Hopper\Agent,
// started elevated by a scheduled task, serves those commands over a named pipe that only this
// Windows account (by SID) can open, keeps one instance listening, reads at most 64 KB per request,
// and exits after ten idle minutes.

using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Hopper
{
    static class Unlock
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        public static bool Handles(string cmd)
        {
            switch (cmd)
            {
                case "rmHolders": case "rmShutdown": case "explorerWindows": case "explorerRelease":
                case "smbOpenFiles": case "smbCloseFile": case "smbSessions": case "auditLog": case "agentCall": case "elevated":
                    return true;
                default:
                    return false;
            }
        }

        public static string Dispatch(string cmd, Dictionary<string, object> a, UiThread ui)
        {
            switch (cmd)
            {
                case "rmHolders": return Json.Serialize(Holders(Paths(a, "paths", 2000)));
                case "rmShutdown": return Json.Serialize(Shutdown(OnePath(a, "path"), Int(a, "pid"), Str(a, "start")));
                case "explorerWindows":
                {
                    var paths = Paths(a, "paths", 200);
                    object r = null;
                    ui.Invoke(delegate { r = ExplorerWindows(paths, null); });
                    return Json.Serialize(r);
                }
                case "explorerRelease":
                {
                    var paths = Paths(a, "paths", 200);
                    string to = Str(a, "to");
                    object r = null;
                    ui.Invoke(delegate { r = ExplorerWindows(paths, to); });
                    var moved = new Dictionary<string, object>();
                    moved["moved"] = ((List<Dictionary<string, object>>)r).Count;
                    return Json.Serialize(moved);
                }
                case "smbOpenFiles": return Json.Serialize(SmbOpenFiles(OnePath(a, "path")));
                case "smbCloseFile": return Json.Serialize(SmbCloseFile(Int(a, "id")));
                case "smbSessions": return Json.Serialize(SmbSessions());
                case "auditLog": return Json.Serialize(AuditLog(Str(a, "line")));
                case "agentCall":
                {
                    object inner = a.ContainsKey("args") ? a["args"] : null;
                    return AgentCall(Str(a, "cmd"), inner as Dictionary<string, object> ?? new Dictionary<string, object>());
                }
                case "elevated": return IsElevated() ? "true" : "false";
                default: throw new Exception("unknown command " + cmd);
            }
        }

        // ---- arguments -------------------------------------------------------------

        static string Str(Dictionary<string, object> a, string k) { return a.ContainsKey(k) && a[k] != null ? Convert.ToString(a[k]) : ""; }
        static int Int(Dictionary<string, object> a, string k)
        {
            if (!a.ContainsKey(k) || a[k] == null) throw new Exception(k + " is required");
            return Convert.ToInt32(a[k]);
        }

        /** An absolute drive or UNC path without wildcards or control characters. */
        static string Check(string p)
        {
            if (string.IsNullOrEmpty(p) || p.Length > 1024) throw new Exception("bad path");
            foreach (char c in p) if (c < 0x20 || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') throw new Exception("bad path");
            bool drive = p.Length >= 3 && char.IsLetter(p[0]) && p[1] == ':' && p[2] == '\\';
            bool unc = p.StartsWith("\\\\", StringComparison.Ordinal) && p.Length > 4;
            if (!drive && !unc) throw new Exception("not an absolute path: " + p);
            return p;
        }

        static string OnePath(Dictionary<string, object> a, string k) { return Check(Str(a, k)); }

        static List<string> Paths(Dictionary<string, object> a, string k, int max)
        {
            var list = new List<string>();
            if (!a.ContainsKey(k) || a[k] == null || !(a[k] is IEnumerable) || a[k] is string) throw new Exception(k + " must be a list");
            foreach (var o in (IEnumerable)a[k]) list.Add(Check(Convert.ToString(o)));
            if (list.Count == 0 || list.Count > max) throw new Exception(k + ": 1 to " + max + " paths");
            return list;
        }

        // ---- Restart Manager -----------------------------------------------------------

        const int CCH_RM_SESSION_KEY = 32;
        const int ERROR_MORE_DATA = 234;

        [StructLayout(LayoutKind.Sequential)]
        struct RM_UNIQUE_PROCESS
        {
            public int dwProcessId;
            public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct RM_PROCESS_INFO
        {
            public RM_UNIQUE_PROCESS Process;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
            public int ApplicationType;
            public uint AppStatus;
            public uint TSSessionId;
            [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
        }

        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
        static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);
        [DllImport("rstrtmgr.dll")]
        static extern int RmEndSession(uint pSessionHandle);
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
        static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
        [DllImport("rstrtmgr.dll")]
        static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
        [DllImport("rstrtmgr.dll")]
        static extern int RmShutdown(uint pSessionHandle, uint lActionFlags, IntPtr fnStatus);

        static List<RM_PROCESS_INFO> Processes(string[] files)
        {
            uint h;
            var key = new StringBuilder(CCH_RM_SESSION_KEY + 1);
            int r = RmStartSession(out h, 0, key);
            if (r != 0) throw new Win32Exception(r);
            try
            {
                r = RmRegisterResources(h, (uint)files.Length, files, 0, null, 0, null);
                if (r != 0) throw new Win32Exception(r);
                uint needed, count = 0, reasons = 0;
                RM_PROCESS_INFO[] info = null;
                for (int tries = 0; ; tries++)
                {
                    r = RmGetList(h, out needed, ref count, info, ref reasons);
                    if (r == 0) break;
                    if (r != ERROR_MORE_DATA || tries >= 4) throw new Win32Exception(r);
                    count = needed;
                    info = new RM_PROCESS_INFO[needed];
                }
                var list = new List<RM_PROCESS_INFO>();
                for (int i = 0; i < count && info != null; i++) list.Add(info[i]);
                return list;
            }
            finally
            {
                RmEndSession(h);
            }
        }

        static string StartTicks(RM_UNIQUE_PROCESS p)
        {
            ulong t = ((ulong)(uint)p.ProcessStartTime.dwHighDateTime << 32) | (uint)p.ProcessStartTime.dwLowDateTime;
            return t.ToString();
        }

        static string TypeName(int t)
        {
            switch (t)
            {
                case 1: return "window";
                case 2: return "other-window";
                case 3: return "service";
                case 4: return "explorer";
                case 5: return "console";
                case 1000: return "critical";
                default: return "unknown";
            }
        }

        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const uint TOKEN_QUERY = 0x0008;
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder name, ref int size);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        static void Describe(int pid, Dictionary<string, object> d)
        {
            IntPtr ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (ph == IntPtr.Zero) return;
            try
            {
                var sb = new StringBuilder(1024);
                int n = sb.Capacity;
                if (QueryFullProcessImageNameW(ph, 0, sb, ref n)) d["exe"] = sb.ToString(0, n);
                IntPtr tok;
                if (OpenProcessToken(ph, TOKEN_QUERY, out tok))
                {
                    try { using (var id = new WindowsIdentity(tok)) d["user"] = id.Name; }
                    catch { /* other account */ }
                    finally { CloseHandle(tok); }
                }
            }
            finally
            {
                CloseHandle(ph);
            }
        }

        static Dictionary<string, object> Row(string path, RM_PROCESS_INFO p)
        {
            var d = new Dictionary<string, object>();
            d["path"] = path;
            d["pid"] = p.Process.dwProcessId;
            d["start"] = StartTicks(p.Process);
            d["app"] = p.strAppName ?? "";
            d["type"] = TypeName(p.ApplicationType);
            d["session"] = (long)p.TSSessionId;
            d["restartable"] = p.bRestartable;
            if (!string.IsNullOrEmpty(p.strServiceShortName)) d["service"] = p.strServiceShortName;
            Describe(p.Process.dwProcessId, d);
            return d;
        }

        const int PER_FILE_MAX = 300;

        /** Processes holding each file. A file that is not open is simply absent; one RM failure does not stop the rest. */
        static List<Dictionary<string, object>> Holders(List<string> paths)
        {
            var rows = new List<Dictionary<string, object>>();
            var all = new List<RM_PROCESS_INFO>();
            for (int i = 0; i < paths.Count; i += 500)
            {
                var chunk = paths.GetRange(i, Math.Min(500, paths.Count - i)).ToArray();
                all.AddRange(Processes(chunk));
            }
            if (all.Count == 0) return rows;
            if (paths.Count == 1)
            {
                foreach (var p in all) rows.Add(Row(paths[0], p));
                return rows;
            }
            // attribute each process to its files, one session per file (bounded)
            var placed = new HashSet<string>();
            for (int i = 0; i < paths.Count && i < PER_FILE_MAX; i++)
            {
                List<RM_PROCESS_INFO> one;
                try { one = Processes(new[] { paths[i] }); }
                catch { continue; }
                foreach (var p in one)
                {
                    rows.Add(Row(paths[i], p));
                    placed.Add(p.Process.dwProcessId + ":" + StartTicks(p.Process));
                }
            }
            // more files than that: a holder not placed yet is reported without a file ("" = somewhere in the request)
            foreach (var p in all)
            {
                string k = p.Process.dwProcessId + ":" + StartTicks(p.Process);
                if (placed.Add(k)) rows.Add(Row("", p));
            }
            return rows;
        }

        /** Ask one app to close (graceful, no force). Only a window or console app in this Windows session that still holds the file. */
        static Dictionary<string, object> Shutdown(string path, int pid, string start)
        {
            var res = new Dictionary<string, object>();
            RM_PROCESS_INFO? hit = null;
            foreach (var p in Processes(new[] { path }))
                if (p.Process.dwProcessId == pid && StartTicks(p.Process) == start) hit = p;
            if (hit == null)
            {
                res["ok"] = true;
                res["code"] = 0;
                res["already"] = true; // no longer holds the file
                return res;
            }
            var h0 = hit.Value;
            int t = h0.ApplicationType;
            if (t == 3 || t == 4 || t == 1000) throw new Exception("refused: " + TypeName(t) + " processes are never closed");
            if (pid == Process.GetCurrentProcess().Id) throw new Exception("refused: Hopper's own helper");
            if (h0.TSSessionId != (uint)Process.GetCurrentProcess().SessionId) throw new Exception("refused: the app runs in another Windows session");
            uint h;
            var key = new StringBuilder(CCH_RM_SESSION_KEY + 1);
            int r = RmStartSession(out h, 0, key);
            if (r != 0) throw new Win32Exception(r);
            try
            {
                r = RmRegisterResources(h, 0, null, 1, new[] { h0.Process }, 0, null);
                if (r != 0) throw new Win32Exception(r);
                r = RmShutdown(h, 0, IntPtr.Zero); // 0: graceful; never RmForceShutdown
            }
            finally
            {
                RmEndSession(h);
            }
            res["ok"] = r == 0;
            res["code"] = r;
            if (r != 0) res["error"] = r == 351 ? "the app did not close (it may be waiting for someone to save)" : new Win32Exception(r).Message;
            return res;
        }

        // ---- File Explorer windows ------------------------------------------------------

        static object Get(object o, string name) { return o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, null); }
        static object Call(object o, string name, params object[] args) { return o.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, o, args); }
        static void Release(object o) { if (o != null && Marshal.IsComObject(o)) { try { Marshal.ReleaseComObject(o); } catch { } } }

        static bool Within(string p, string root)
        {
            string a = p.TrimEnd('\\');
            string b = root.TrimEnd('\\');
            return string.Equals(a, b, StringComparison.OrdinalIgnoreCase) || a.StartsWith(b + "\\", StringComparison.OrdinalIgnoreCase);
        }

        /** Explorer windows showing one of `roots` or a folder inside one; with `to`, move them there (or close them). Runs on the STA thread. */
        static List<Dictionary<string, object>> ExplorerWindows(List<string> roots, string to)
        {
            var found = new List<Dictionary<string, object>>();
            Type t = Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39")); // ShellWindows
            object wins = null;
            try
            {
                wins = Activator.CreateInstance(t);
                int n = Convert.ToInt32(Get(wins, "Count"));
                for (int i = 0; i < n; i++)
                {
                    object w = null, doc = null, folder = null, self = null;
                    try
                    {
                        w = Call(wins, "Item", i);
                        if (w == null) continue;
                        string full = Convert.ToString(Get(w, "FullName") ?? "");
                        if (!full.EndsWith("explorer.exe", StringComparison.OrdinalIgnoreCase)) continue;
                        doc = Get(w, "Document");
                        if (doc == null) continue;
                        folder = Get(doc, "Folder");
                        if (folder == null) continue;
                        self = Get(folder, "Self");
                        string path = self == null ? "" : Convert.ToString(Get(self, "Path") ?? "");
                        if (string.IsNullOrEmpty(path)) continue;
                        bool match = false;
                        foreach (var r in roots) if (Within(path, r)) match = true;
                        if (!match) continue;
                        var d = new Dictionary<string, object>();
                        d["path"] = path;
                        d["hwnd"] = Convert.ToInt64(Get(w, "HWND"));
                        found.Add(d);
                        if (to != null)
                        {
                            bool moved = false;
                            if (to.Length > 0 && Directory.Exists(to))
                            {
                                try { Call(w, "Navigate2", to); moved = true; } catch { }
                            }
                            if (!moved) { try { Call(w, "Quit"); } catch { } }
                        }
                    }
                    catch
                    {
                        /* a window closing while we look */
                    }
                    finally
                    {
                        Release(self); Release(folder); Release(doc); Release(w);
                    }
                }
            }
            finally
            {
                Release(wins);
            }
            return found;
        }

        // ---- SMB server view (server agent) ---------------------------------------------

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct FILE_INFO_3
        {
            public int fi3_id;
            public int fi3_permissions;
            public int fi3_num_locks;
            public string fi3_pathname;
            public string fi3_username;
        }

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        static extern int NetFileEnum(string servername, string basepath, string username, int level, out IntPtr bufptr, int prefmaxlen, out int entriesread, out int totalentries, ref IntPtr resume_handle);
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        static extern int NetFileClose(string servername, int fileid);
        [DllImport("netapi32.dll")]
        static extern int NetApiBufferFree(IntPtr buf);

        public static bool IsElevated()
        {
            using (var id = WindowsIdentity.GetCurrent()) return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
        }

        static Dictionary<string, object> SmbOpenFiles(string localPath)
        {
            var res = new Dictionary<string, object>();
            var files = new List<Dictionary<string, object>>();
            IntPtr resume = IntPtr.Zero;
            int size = Marshal.SizeOf(typeof(FILE_INFO_3));
            for (int round = 0; round < 50; round++)
            {
                IntPtr buf;
                int read, total;
                int r = NetFileEnum(null, localPath.TrimEnd('\\'), null, 3, out buf, -1, out read, out total, ref resume);
                try
                {
                    if (r != 0 && r != ERROR_MORE_DATA)
                    {
                        res["ok"] = false;
                        res["error"] = r == 5 ? "needs-admin" : new Win32Exception(r).Message;
                        res["code"] = r;
                        return res;
                    }
                    for (int i = 0; i < read; i++)
                    {
                        var fi = (FILE_INFO_3)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * size), typeof(FILE_INFO_3));
                        var d = new Dictionary<string, object>();
                        d["id"] = (long)(uint)fi.fi3_id;
                        d["path"] = fi.fi3_pathname ?? "";
                        d["user"] = fi.fi3_username ?? "";
                        d["locks"] = fi.fi3_num_locks;
                        files.Add(d);
                    }
                }
                finally
                {
                    if (buf != IntPtr.Zero) NetApiBufferFree(buf);
                }
                if (r != ERROR_MORE_DATA) break;
            }
            res["ok"] = true;
            res["files"] = files;
            return res;
        }

        static Dictionary<string, object> SmbCloseFile(int id)
        {
            var res = new Dictionary<string, object>();
            if (id < 0) throw new Exception("bad id");
            // only a file that is open under one of this server's ordinary disk shares (never C$, ADMIN$, IPC$ …)
            int code;
            string path = OpenFilePath(id, out code);
            if (path == null)
            {
                res["ok"] = false;
                res["error"] = code == 5 ? "needs-admin" : "not-open";
                return res;
            }
            bool shared = false;
            foreach (var s in Props.Shares(false))
                if (Within(path, Convert.ToString(s["path"]))) shared = true;
            if (!shared)
            {
                res["ok"] = false;
                res["error"] = "not-under-a-share";
                return res;
            }
            int r = NetFileClose(null, id);
            res["ok"] = r == 0;
            res["path"] = path;
            if (r != 0)
            {
                res["code"] = r;
                res["error"] = r == 5 ? "needs-admin" : r == 2314 ? "not-open" : new Win32Exception(r).Message;
            }
            return res;
        }

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        static extern int NetFileGetInfo(string servername, int fileid, int level, out IntPtr bufptr);

        static string OpenFilePath(int id, out int code)
        {
            IntPtr buf;
            int r = NetFileGetInfo(null, id, 3, out buf);
            code = r;
            if (r != 0 || buf == IntPtr.Zero) return null;
            try
            {
                var fi = (FILE_INFO_3)Marshal.PtrToStructure(buf, typeof(FILE_INFO_3));
                return fi.fi3_pathname;
            }
            finally
            {
                NetApiBufferFree(buf);
            }
        }

        // ---- SMB sessions: who is connected from which address (proves who asks for a force close) ----

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct SESSION_INFO_10
        {
            public string sesi10_cname;
            public string sesi10_username;
            public uint sesi10_time;
            public uint sesi10_idle_time;
        }

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        static extern int NetSessionEnum(string servername, string uncClientName, string username, int level, out IntPtr bufptr, int prefmaxlen, out int entriesread, out int totalentries, ref int resume_handle);

        static Dictionary<string, object> SmbSessions()
        {
            var res = new Dictionary<string, object>();
            var list = new List<Dictionary<string, object>>();
            int resume = 0;
            int size = Marshal.SizeOf(typeof(SESSION_INFO_10));
            for (int round = 0; round < 50; round++)
            {
                IntPtr buf;
                int read, total;
                int r = NetSessionEnum(null, null, null, 10, out buf, -1, out read, out total, ref resume);
                try
                {
                    if (r != 0 && r != ERROR_MORE_DATA)
                    {
                        res["ok"] = false;
                        res["error"] = r == 5 ? "needs-admin" : new Win32Exception(r).Message;
                        return res;
                    }
                    for (int i = 0; i < read; i++)
                    {
                        var si = (SESSION_INFO_10)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * size), typeof(SESSION_INFO_10));
                        var d = new Dictionary<string, object>();
                        d["client"] = (si.sesi10_cname ?? "").TrimStart('\\');
                        d["user"] = si.sesi10_username ?? "";
                        list.Add(d);
                    }
                }
                finally
                {
                    if (buf != IntPtr.Zero) NetApiBufferFree(buf);
                }
                if (r != ERROR_MORE_DATA) break;
            }
            res["ok"] = true;
            res["sessions"] = list;
            return res;
        }

        // ---- force-close log, writable only with admin rights ----------------------------

        static Dictionary<string, object> AuditLog(string line)
        {
            var res = new Dictionary<string, object>();
            if (string.IsNullOrEmpty(line) || line.Length > 8192 || line.IndexOf('\n') >= 0 || line.IndexOf('\r') >= 0) throw new Exception("bad log line");
            if (!IsElevated())
            {
                res["ok"] = false;
                res["error"] = "needs-admin";
                return res;
            }
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Hopper");
            if (!Directory.Exists(dir))
            {
                // SYSTEM and Administrators may write; everyone else may only read
                var sec = new DirectorySecurity();
                sec.SetAccessRuleProtection(true, false);
                var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
                sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
                sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
                sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.CreateDirectory(dir, sec);
            }
            string file = Path.Combine(dir, "unlock-log.jsonl");
            File.AppendAllText(file, line + "\n", new UTF8Encoding(false));
            res["ok"] = true;
            res["path"] = file;
            return res;
        }

        // ---- talking to the agent from the ordinary helper ------------------------------

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint pid);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int len, out int retLen);

        /** Where setup puts the agent: Program Files, writable only by administrators. */
        public static string AgentExe()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Hopper", "Agent", "HopperShell.exe");
        }

        /** Relay one command to the elevated agent, after checking the pipe is served by the protected agent exe. */
        static string AgentCall(string cmd, Dictionary<string, object> args)
        {
            if (cmd != "smbOpenFiles" && cmd != "smbCloseFile" && cmd != "smbSessions" && cmd != "auditLog" && cmd != "elevated") throw new Exception("not an agent command");
            using (var pipe = new NamedPipeClientStream(".", Agent.PipeName(), PipeDirection.InOut))
            {
                try { pipe.Connect(2000); }
                catch (TimeoutException) { throw new Exception("agent-not-running"); }
                catch (IOException) { throw new Exception("agent-not-running"); }
                uint pid;
                if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid)) throw new Exception("agent-untrusted");
                IntPtr ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (int)pid);
                if (ph == IntPtr.Zero) throw new Exception("agent-untrusted");
                try
                {
                    var sb = new StringBuilder(1024);
                    int n = sb.Capacity;
                    if (!QueryFullProcessImageNameW(ph, 0, sb, ref n) || !string.Equals(sb.ToString(0, n), AgentExe(), StringComparison.OrdinalIgnoreCase)) throw new Exception("agent-untrusted");
                    IntPtr tok;
                    if (OpenProcessToken(ph, TOKEN_QUERY, out tok))
                    {
                        try
                        {
                            int elevated, len;
                            if (GetTokenInformation(tok, 20, out elevated, 4, out len) && elevated == 0) throw new Exception("agent-not-elevated");
                        }
                        finally { CloseHandle(tok); }
                    }
                }
                finally
                {
                    CloseHandle(ph);
                }
                var req = new Dictionary<string, object>();
                req["id"] = 1;
                req["cmd"] = cmd;
                req["args"] = args;
                byte[] line = Encoding.UTF8.GetBytes(Json.Serialize(req) + "\n");
                pipe.Write(line, 0, line.Length);
                pipe.Flush();
                string reply = Agent.ReadLine(pipe, 16 * 1024 * 1024);
                if (reply == null) throw new Exception("agent gave no answer");
                var m = (Dictionary<string, object>)Json.DeserializeObject(reply);
                if (!(m.ContainsKey("ok") && m["ok"] is bool && (bool)m["ok"])) throw new Exception(Convert.ToString(m.ContainsKey("error") ? m["error"] : "agent error"));
                return Json.Serialize(m["result"]);
            }
        }
    }

    /// <summary>Elevated server agent: open files, sessions, close one file and the log, over a named pipe for this account only.</summary>
    static class Agent
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        static long lastUse;
        const int IDLE_MS = 10 * 60 * 1000;
        const int MAX_REQUEST = 64 * 1024;

        static string Sid()
        {
            using (var id = WindowsIdentity.GetCurrent()) return id.User.Value;
        }

        /** Per account (by SID), so another account cannot take the name over. */
        public static string PipeName()
        {
            return "hopper-unlock-" + Sid();
        }

        /** One '\n'-terminated line, at most `max` bytes; null on end of stream or when too long. */
        public static string ReadLine(Stream s, int max)
        {
            var buf = new MemoryStream();
            var one = new byte[4096];
            while (true)
            {
                int n = s.Read(one, 0, one.Length);
                if (n <= 0) return null;
                int nl = Array.IndexOf(one, (byte)'\n', 0, n);
                buf.Write(one, 0, nl >= 0 ? nl : n);
                if (buf.Length > max) return null;
                if (nl >= 0) return Encoding.UTF8.GetString(buf.ToArray());
            }
        }

        static NamedPipeServerStream Create(PipeSecurity sec)
        {
            return new NamedPipeServerStream(PipeName(), PipeDirection.InOut, 2, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, sec);
        }

        public static int Run()
        {
            using (var single = new Mutex(false, "Local\\hopper-unlock-agent-" + Sid()))
            {
                bool mine;
                try { mine = single.WaitOne(0); }
                catch (AbandonedMutexException) { mine = true; }
                if (!mine) return 0; // another agent already serves this account
                SecurityIdentifier me;
                using (var id = WindowsIdentity.GetCurrent()) me = id.User;
                var sec = new PipeSecurity();
                sec.AddAccessRule(new PipeAccessRule(me, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
                // never from another computer
                sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
                Interlocked.Exchange(ref lastUse, Environment.TickCount);
                var idle = new Timer(delegate
                {
                    if (unchecked(Environment.TickCount - Interlocked.Read(ref lastUse)) > IDLE_MS) Environment.Exit(0);
                }, null, 60000, 60000);
                NamedPipeServerStream cur;
                try { cur = Create(sec); }
                catch (Exception) { return 0; } // the name is taken: clients refuse a pipe that is not this exe anyway
                while (true)
                {
                    try { cur.WaitForConnection(); }
                    catch (Exception) { cur.Dispose(); return 0; }
                    Interlocked.Exchange(ref lastUse, Environment.TickCount);
                    // keep an instance listening while this one is served, so nobody else can take the name
                    NamedPipeServerStream next = null;
                    try { next = Create(sec); } catch { }
                    try
                    {
                        string line = ReadLine(cur, MAX_REQUEST);
                        byte[] reply = Encoding.UTF8.GetBytes((line == null ? Error(0, "request too long or empty") : Handle(line)) + "\n");
                        cur.Write(reply, 0, reply.Length);
                        cur.Flush();
                        cur.WaitForPipeDrain();
                    }
                    catch
                    {
                        /* the client went away */
                    }
                    cur.Dispose();
                    if (next == null)
                    {
                        try { next = Create(sec); }
                        catch (Exception) { return 0; }
                    }
                    cur = next;
                    GC.KeepAlive(idle);
                }
            }
        }

        static string Error(long id, string message)
        {
            return "{\"id\":" + id + ",\"ok\":false,\"error\":" + Json.Serialize(message) + "}";
        }

        static string Handle(string line)
        {
            long id = 0;
            try
            {
                var req = (Dictionary<string, object>)Json.DeserializeObject(line);
                id = Convert.ToInt64(req["id"]);
                string cmd = Convert.ToString(req["cmd"]);
                var args = req.ContainsKey("args") && req["args"] != null ? (Dictionary<string, object>)req["args"] : new Dictionary<string, object>();
                if (cmd != "smbOpenFiles" && cmd != "smbCloseFile" && cmd != "smbSessions" && cmd != "auditLog" && cmd != "elevated" && cmd != "ping") throw new Exception("not served by the agent: " + cmd);
                string result = cmd == "ping" ? "\"pong\"" : Unlock.Dispatch(cmd, args, null);
                return "{\"id\":" + id + ",\"ok\":true,\"result\":" + result + "}";
            }
            catch (Exception ex)
            {
                return Error(id, ex.Message);
            }
        }
    }
}
