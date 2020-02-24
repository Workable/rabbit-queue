export default function getLogger(component) {
  const logger = level => async (...args) => {
    // There was no way to move this to top due to cyclic dependencies.
    const rabbit = (await import('./rabbit')).default;
    if (rabbit.INSTANCE && rabbit.INSTANCE.listenerCount('log') > 0) {
      return void rabbit.INSTANCE.emit('log', component, level, ...args);
    }
    console.log(`[${level}] ${component}`, ...args);
  };

  return {
    debug: logger('debug'),
    warn: logger('warn'),
    info: logger('info'),
    error: logger('erro')
  };
}
