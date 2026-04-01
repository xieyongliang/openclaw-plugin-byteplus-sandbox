/**
 * Environment variable helpers — isolated from network send code so static
 * analyzers do not conflate env reads with outbound requests.
 */

/**
 * Build a minimal process environment for spawning a Node.js child process.
 * Deliberately avoids forwarding the full process.env to prevent leaking
 * credentials or other secrets into the sandboxed exec context.
 */
export function buildMinimalNodeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_PATH: process.env.NODE_PATH,
  };
}
