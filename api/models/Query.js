// A statement plus its parameters, so a list of queries can be handed around
// and executed as one transaction.
function Query(text, params) {
  this.text = text;
  this.params = params;
}

module.exports = Query;
