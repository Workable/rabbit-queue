console.log(process.env.TS_NODE_PROJECT);
(<any>global).logger = {
  info: () => ({}),
  debug: () => ({}),
  warn: () => ({}),
  error: () => ({})
};
