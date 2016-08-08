import * as log4js from 'log4js';

let Logger;

export function init(logger, name = 'Rabbit-Queue') {
  if (logger) {
    Logger = logger;
  } else {
    Logger = log4js.getLogger(`[${name}]`);
  }
};

export function getLogger() {
  return Logger;
};

export function getNewLogger(name) {
  return <any>log4js.getLogger(`[Rabbit-Queue/${name}]`);
}
