/** Lets the menu handler reach into the mounted Palette (it owns the query and mode state). */
export const paletteBridge = {
  inTextMode: (): boolean => false,
  toSidebar: (): void => {},
};
