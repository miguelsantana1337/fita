export class DownloadScheduler {
  constructor({ maxActive = 4, runner, onChange = () => {} }) {
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new Error("O limite global de downloads precisa ser um inteiro positivo.");
    }
    if (typeof runner !== "function") throw new Error("Um executor de downloads é obrigatório.");
    this.maxActive = maxActive;
    this.runner = runner;
    this.onChange = onChange;
    this.queue = [];
    this.active = new Map();
    this.activeByGroup = new Map();
    this.lastStartedGroup = null;
  }

  enqueue(job) {
    if (!job?.id) throw new Error("O download precisa de um identificador.");
    if (this.queue.some((entry) => entry.id === job.id) || this.active.has(job.id)) return false;
    job.state = "queued";
    this.queue.push(job);
    this.onChange(job);
    this.pump();
    return true;
  }

  cancelQueued(id) {
    const index = this.queue.findIndex((job) => job.id === id);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  stats() {
    return { active: this.active.size, queued: this.queue.length, limit: this.maxActive };
  }

  pump() {
    while (this.active.size < this.maxActive) {
      const isEligible = (job) => {
        const key = job.batchId || job.id;
        const activeInGroup = this.activeByGroup.get(key) || 0;
        const limit = job.batchConcurrency || this.maxActive;
        return activeInGroup < limit;
      };
      let index = this.queue.findIndex((job) => {
        const key = job.batchId || job.id;
        return key !== this.lastStartedGroup && isEligible(job);
      });
      if (index < 0) index = this.queue.findIndex(isEligible);
      if (index < 0) return;

      const [job] = this.queue.splice(index, 1);
      const key = job.batchId || job.id;
      job.state = "starting";
      job.startedAt ||= Date.now();
      this.active.set(job.id, job);
      this.activeByGroup.set(key, (this.activeByGroup.get(key) || 0) + 1);
      this.lastStartedGroup = key;
      this.onChange(job);

      Promise.resolve()
        .then(() => this.runner(job))
        .catch((error) => {
          if (!job.cancelRequested) {
            job.state = "error";
            job.error ||= error?.message || "Não foi possível concluir o download.";
            job.finishedAt ||= Date.now();
          }
        })
        .finally(() => {
          this.active.delete(job.id);
          const nextCount = Math.max(0, (this.activeByGroup.get(key) || 1) - 1);
          if (nextCount) this.activeByGroup.set(key, nextCount);
          else this.activeByGroup.delete(key);
          this.onChange(job);
          this.pump();
        });
    }
  }
}
