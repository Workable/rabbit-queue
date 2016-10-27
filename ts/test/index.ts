import { install } from 'source-map-support';

install();

(<any>global).logger = {
  info: () => ({}),
  debug: () => ({}),
  warn: () => ({}),
  error: () => ({})
}
