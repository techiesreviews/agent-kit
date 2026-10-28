// This test process's environment without the kit's own home names. The kit run that started the tests exports
// KIT_HOME, and KIT_HOME_DEFAULT when its front door filled that in: a fixture inheriting a person's KIT_HOME would
// run that other kit, and one inheriting KIT_HOME_DEFAULT would read a KIT_HOME it set itself as a front door's.
export function kitEnv(): NodeJS.ProcessEnv {
  const { KIT_HOME: _home, KIT_HOME_DEFAULT: _default, ...env } = process.env;
  return env;
}
