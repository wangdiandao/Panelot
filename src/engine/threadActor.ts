export class ThreadActor {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class ThreadActorRegistry {
  private actors = new Map<string, ThreadActor>();

  run<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    let actor = this.actors.get(threadId);
    if (!actor) {
      actor = new ThreadActor();
      this.actors.set(threadId, actor);
    }
    return actor.run(operation);
  }
}
