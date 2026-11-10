// Hopper native helper — (c) Dexterity Design Services Private Limited. Internal software.
// The document types offered under "New": read from the same registry entries Windows keeps for
// installed programs (HKCR\.ext\[ProgID\]ShellNew), so Word, Excel and the rest appear when
// they are installed. Hopper builds its own menu from this; nothing is handed to Explorer.
using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.Win32;

namespace Hopper
{
    static class ShellNew
    {
        static readonly HashSet<string> Skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".lnk", ".library-ms", ".contact", ".url", ".bfc", ".zfsendtotarget", ".mapimail", ".desklink", ".searchconnector-ms"
        };

        public static object List()
        {
            var outList = new List<object>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var root = Registry.ClassesRoot)
            {
                foreach (var ext in root.GetSubKeyNames())
                {
                    if (ext.Length < 2 || ext[0] != '.' || Skip.Contains(ext)) continue;
                    try
                    {
                        using (var k = root.OpenSubKey(ext))
                        {
                            if (k == null) continue;
                            var progId = k.GetValue(null) as string;
                            RegistryKey sn = null;
                            if (!string.IsNullOrEmpty(progId)) sn = k.OpenSubKey(progId + ((char)92) + "ShellNew");
                            if (sn == null) sn = k.OpenSubKey("ShellNew");
                            if (sn == null)
                            {
                                // the default program may have been changed; the entry stays under the original one
                                foreach (var sub in k.GetSubKeyNames())
                                {
                                    sn = k.OpenSubKey(sub + ((char)92) + "ShellNew");
                                    if (sn != null) { if (string.IsNullOrEmpty(TypeNameOrNull(root, progId))) progId = sub; break; }
                                }
                            }
                            if (sn == null) continue;
                            using (sn)
                            {
                                string template = null;
                                string data = null;
                                bool ok = false;
                                var fileName = sn.GetValue("FileName") as string;
                                if (!string.IsNullOrEmpty(fileName))
                                {
                                    template = Resolve(Environment.ExpandEnvironmentVariables(fileName));
                                    ok = template != null;
                                }
                                if (!ok && sn.GetValue("Data") != null)
                                {
                                    var raw = sn.GetValue("Data");
                                    var bytes = raw as byte[];
                                    if (bytes == null && raw is string) bytes = System.Text.Encoding.Default.GetBytes((string)raw);
                                    if (bytes != null) { data = Convert.ToBase64String(bytes); ok = true; }
                                }
                                if (!ok && sn.GetValue("NullFile") != null) ok = true;
                                if (!ok) continue; // "Command" entries start a wizard; not a plain new file
                                var label = TypeName(root, progId, ext);
                                if (!seen.Add(ext)) continue;
                                var item = new Dictionary<string, object>();
                                item["ext"] = ext.ToLowerInvariant();
                                item["label"] = label;
                                item["template"] = template;
                                item["data"] = data;
                                outList.Add(item);
                            }
                        }
                    }
                    catch { /* unreadable key: skip */ }
                }
            }
            // Office keeps its blank documents in one folder; offer them even when the registry entry is missing.
            var office = new[] { new[] { ".docx", "WORD.DOCX", "Microsoft Word Document" }, new[] { ".xlsx", "EXCEL12.XLSX", "Microsoft Excel Worksheet" }, new[] { ".pptx", "POWERPOINT.PPTX", "Microsoft PowerPoint Presentation" } };
            foreach (var o in office)
            {
                if (seen.Contains(o[0])) continue;
                foreach (var pf in new[] { Environment.GetEnvironmentVariable("ProgramW6432"), Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramFiles(x86)") })
                {
                    if (string.IsNullOrEmpty(pf)) continue;
                    var f = Path.Combine(Path.Combine(Path.Combine(Path.Combine(Path.Combine(Path.Combine(pf, "Microsoft Office"), "root"), "vfs"), "Windows"), "ShellNew"), o[1]);
                    if (!File.Exists(f)) continue;
                    var item = new Dictionary<string, object>();
                    item["ext"] = o[0];
                    item["label"] = o[2];
                    item["template"] = f;
                    item["data"] = null;
                    outList.Add(item);
                    seen.Add(o[0]);
                    break;
                }
            }
            return outList;
        }

        static string TypeNameOrNull(RegistryKey root, string progId)
        {
            if (string.IsNullOrEmpty(progId)) return null;
            try { using (var p = root.OpenSubKey(progId)) { return p == null ? null : p.GetValue(null) as string; } } catch { return null; }
        }

        static string Resolve(string file)
        {
            if (Path.IsPathRooted(file)) return File.Exists(file) ? file : null;
            var places = new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.Templates),
                Environment.GetFolderPath(Environment.SpecialFolder.CommonTemplates),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "ShellNew")
            };
            foreach (var p in places)
            {
                if (string.IsNullOrEmpty(p)) continue;
                var full = Path.Combine(p, file);
                if (File.Exists(full)) return full;
            }
            return null;
        }

        static string TypeName(RegistryKey root, string progId, string ext)
        {
            if (!string.IsNullOrEmpty(progId))
            {
                try
                {
                    using (var p = root.OpenSubKey(progId))
                    {
                        var n = p == null ? null : p.GetValue(null) as string;
                        if (!string.IsNullOrEmpty(n)) return n;
                    }
                }
                catch { }
            }
            return ext.Substring(1).ToUpperInvariant() + " file";
        }
    }
}
