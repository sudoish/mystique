export type Mode = "embedded" | "external" | "herdr" | "rex";

export function detectMode(env?: NodeJS.ProcessEnv): Mode | undefined;
export function nvimActive(env?: NodeJS.ProcessEnv): boolean;
export function reachLabel(env?: NodeJS.ProcessEnv): string | undefined;
