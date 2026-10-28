/** Bridge exposed by the Electron preload script; undefined in a normal browser. */
interface Window {
  winagentDesktop?: { notify(title: string, body: string): Promise<boolean> };
}
