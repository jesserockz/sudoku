/** Runs async sections one at a time, in call order. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(section: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(section);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
