// MicroStation's default colour table: the 768 bytes of Workspace/system/data/color.tbl as shipped
// with MicroStation/J (entry 255, the background, comes first, then entries 0 to 254 - the same
// order a colour table element uses). Used only when a design file carries no colour table.
const B64 =
  'AAAA////AAD/AP8A/wAA//8A/wD//38AAP//QEBAwMDA/gBgoOAAAP6ggACgsLCwAPDw8PDwAADwAPAA8AAA8PAA8ADw8HoAAPDw' +
  '8PDwAADwAPAA8AAA8PAA8ADw8HoAAOHh4eHhAADhAOEA4QAA4eEA4QDh4XUAAOHh4eHhAADhAOEA4QAA4eEA4QDh4XUAANLS0tLS' +
  'AADSANIA0gAA0tIA0gDS0nAAANLS0tLSAADSANIA0gAA0tIA0gDS0nAAAMPDw8PDAADDAMMAwwAAw8MAwwDDw2sAAMPDw8PDAADD' +
  'AMMAwwAAw8MAwwDDw2sAALS0tLS0AAC0ALQAtAAAtLQAtAC0tGYAALS0tLS0AAC0ALQAtAAAtLQAtAC0tGYAAKWlpaWlAAClAKUA' +
  'pQAApaUApQClpWEAAKWlpaWlAAClAKUApQAApaUApQClpWEAAJaWlpaWAACWAJYAlgAAlpYAlgCWllwAAJaWlpaWAACWAJYAlgAA' +
  'lpYAlgCWllwAAIeHh4eHAACHAIcAhwAAh4cAhwCHh1cAAIeHh4eHAACHAIcAhwAAh4cAhwCHh1cAAHh4eHh4AAB4AHgAeAAAeHgA' +
  'eAB4eFIAAHh4eHh4AAB4AHgAeAAAeHgAeAB4eFIAAGlpaWlpAABpAGkAaQAAaWkAaQBpaU0AAGlpaWlpAABpAGkAaQAAaWkAaQBp' +
  'aU0AAFpaWlpaAABaAFoAWgAAWloAWgBaWkgAAFpaWlpaAABaAFoAWgAAWloAWgBaWkgAAEtLS0tLAABLAEsASwAAS0sASwBLS0MA' +
  'AEtLS0tLAABLAEsASwAAS0sASwBLS0MAADw8PDw8AAA8ADwAPAAAPDwAPAA8PD4AADw8PDw8AAA8ADwAPAAAPDwAPAA8PD4AAC0t' +
  'LS0tAAAtAC0ALQAALS0ALQAtLTkAAC0tLS0tAAAtAC0ALQAALS0ALQAtLTkAAB4eHh4eAAAeAB4AHgAAHh4AHgAeHjQAAB4eHh4e' +
  'AAAeAB4AHgAAHh4AHgAewMDA'

/** RGB triplets indexed by colour number 0..255. */
export function defaultColors(): Uint8Array {
  return tableToColors(Buffer.from(B64, 'base64'), 0)
}

/** Reorders a stored table (255 first, then 0..254) into plain index order. */
export function tableToColors(buf: Uint8Array, offset: number): Uint8Array {
  const out = new Uint8Array(768)
  for (let i = 0; i < 765; i++) out[i] = buf[offset + 3 + i]
  for (let i = 0; i < 3; i++) out[765 + i] = buf[offset + i]
  return out
}
