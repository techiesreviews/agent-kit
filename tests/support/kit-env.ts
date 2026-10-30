import { resolve } from "node:path";

// This test process's environment without the kit's own home names. The kit run that started the tests exports
// KIT_HOME, and KIT_HOME_DEFAULT when its front door filled that in: a fixture inheriting a person's KIT_HOME would
// run that other kit, and one inheriting KIT_HOME_DEFAULT would read a KIT_HOME it set itself as a front door's.
// KIT_SKILL_DIRS is empty, so kit pr's skill guard never reads the real skill folders under HOME. GH_REPO and GH_HOST
// are left out, so a fixture's gh target comes only from its own remotes, never from the shell that started the tests;
// gh's config is tests/fixtures/gh-config, whose hosts.yml knows github.com and git.example.com, never the real one.
export const ghConfig = resolve(import.meta.dirname, "../fixtures/gh-config");
export function kitEnv(): NodeJS.ProcessEnv {
  const { KIT_HOME: _home, KIT_HOME_DEFAULT: _default, GH_REPO: _repo, GH_HOST: _host, ...env } = process.env;
  return { ...env, KIT_SKILL_DIRS: "", GH_CONFIG_DIR: ghConfig };
}
