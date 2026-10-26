export function runStepsSync(iterator, runTask) {
  try {
    let step = iterator.next()
    while (!step.done) step = iterator.next(step.value ? runTask(step.value) : undefined)
    return step.value
  } catch (error) {
    try { iterator.throw(error) } catch {}
    throw error
  }
}
// Keep input and rendering opportunities between short chunks of topology work.
export async function runStepsAsync(iterator, {runTask, pause = () => new Promise(resolve => setTimeout(resolve, 0)), budget = 6} = {}) {
  let deadline = performance.now() + budget
  try {
    let step = iterator.next()
    while (!step.done) {
      let result
      if (step.value) result = await runTask(step.value)
      if (performance.now() >= deadline) {
        await pause()
        deadline = performance.now() + budget
      }
      step = iterator.next(result)
    }
    return step.value
  } catch (error) {
    try { iterator.throw(error) } catch {}
    throw error
  }
}
