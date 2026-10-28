let runtime
export async function getRuntime() {
  if (!runtime) runtime = (async () => {
    const url = new URL('/wasm/model-builder/manifold.js', self.location.origin).href
    const { default: createModule } = await import(/* webpackIgnore: true */ url)
    const M = await createModule({ locateFile: file => new URL('/wasm/model-builder/' + file, self.location.origin).href })
    M.setup()
    return M
  })()
  return runtime
}
