/**
 * Perf: one-line JSON timing logs, readable in the Executions log and Cloud Logging.
 * Lines carry durations, counts, tab/API names and month keys only, never an e-mail, an id or
 * record contents.
 */
var Perf = (function () {

  function log(fields) {
    try {
      console.log(JSON.stringify(fields));
    } catch (e) { /* logging is best effort */ }
  }

  // var t = Perf.start('importMonth', {month: m}); t.lap('readSource'); t.end({changed: true});
  // A lap name used twice accumulates. Call end() once.
  function start(stage, fields) {
    var t0 = Date.now();
    var last = t0;
    var laps = {};
    return {
      lap: function (name) {
        var now = Date.now();
        laps[name] = (laps[name] || 0) + now - last;
        last = now;
      },
      end: function (extra) {
        var out = { stage: stage, ms: Date.now() - t0 };
        [laps, fields, extra].forEach(function (o) {
          Object.keys(o || {}).forEach(function (k) { out[k] = o[k]; });
        });
        log(out);
      }
    };
  }

  return {
    log: log,
    start: start
  };
})();
