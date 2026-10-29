// Alternate Vite entry: deliberately absent from index.html/router and build inputs.
if (import.meta.env.DEV) {
  void import("./mount");
}
