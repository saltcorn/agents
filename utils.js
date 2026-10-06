const { getState } = require("@saltcorn/data/db/state");

const get__ = (req, user) => {
  if (req?.__) return req?.__;
  const state = getState();
  if (!state) return (s) => s;
  const locale = state.getConfig("default_locale", "en");
  return (s) => state.i18n.__({ phrase: s, locale }) || s;
};

module.exports = { get__ };
