declare module 'node-cron' {
  export interface ScheduleOptions {
    timezone?: string;
  }

  export interface ScheduledTask {
    start(): void;
    stop(): boolean;
    destroy(): void;
    getStatus(): string;
  }

  export function schedule(
    expression: string,
    callback: () => void,
    options?: ScheduleOptions
  ): ScheduledTask;

  export function validate(expression: string): boolean;

  const cron: {
    schedule: typeof schedule;
    validate: typeof validate;
  };

  export default cron;
}
