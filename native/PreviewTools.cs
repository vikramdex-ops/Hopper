// Preview helpers for HopperShell (thumbnails and conversions the UI cannot do itself).
// Dispatch returns a JSON string, or throws for unknown commands.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace Hopper
{
    static class PreviewTools
    {
        public static string Dispatch(string cmd, Dictionary<string, object> a)
        {
            switch (cmd)
            {
                // { kind: "emf" | "wmf", data: base64, max: longest side in px } -> { png, width, height }
                case "metafileToPng":
                    return MetafileToPng(Convert.FromBase64String(Convert.ToString(a["data"])), a.ContainsKey("max") ? Convert.ToInt32(a["max"]) : 2048);
                default: throw new Exception("unknown command " + cmd);
            }
        }

        [DllImport("gdi32.dll")]
        static extern IntPtr SetWinMetaFileBits(uint size, byte[] data, IntPtr hdcRef, IntPtr mfp);

        [DllImport("gdi32.dll")]
        static extern bool DeleteEnhMetaFile(IntPtr hemf);

        // Chromium cannot draw EMF or WMF, so GDI+ plays the metafile onto a white bitmap.
        // A WMF without the placeable header is first turned into an enhanced metafile by GDI.
        static string MetafileToPng(byte[] data, int max)
        {
            if (data.Length < 18 || data.Length > 64 * 1024 * 1024) throw new Exception("metafile size out of range");
            max = Math.Max(64, Math.Min(4096, max));
            IntPtr hemf = IntPtr.Zero;
            Metafile mf = null;
            try
            {
                try { mf = new Metafile(new MemoryStream(data)); }
                catch (Exception)
                {
                    hemf = SetWinMetaFileBits((uint)data.Length, data, IntPtr.Zero, IntPtr.Zero);
                    if (hemf == IntPtr.Zero) throw new Exception("not a readable metafile");
                    mf = new Metafile(hemf, false);
                }
                float w = mf.Width, h = mf.Height;
                if (!(w > 0) || !(h > 0)) throw new Exception("metafile has no size");
                float scale = max / Math.Max(w, h);
                int pw = Math.Max(1, (int)Math.Round(w * scale)), ph = Math.Max(1, (int)Math.Round(h * scale));
                using (var bmp = new Bitmap(pw, ph, PixelFormat.Format32bppArgb))
                {
                    using (var g = Graphics.FromImage(bmp))
                    {
                        g.Clear(Color.White);
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.DrawImage(mf, new Rectangle(0, 0, pw, ph));
                    }
                    using (var ms = new MemoryStream())
                    {
                        bmp.Save(ms, ImageFormat.Png);
                        return "{\"png\":\"" + Convert.ToBase64String(ms.ToArray()) + "\",\"width\":" + pw + ",\"height\":" + ph + "}";
                    }
                }
            }
            finally
            {
                if (mf != null) mf.Dispose();
                if (hemf != IntPtr.Zero) DeleteEnhMetaFile(hemf);
            }
        }
    }
}
