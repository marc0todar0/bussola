function Transaction(id, fromId, toId, amount, typeId, description, txDate) {
  this.id = id;
  this.from_id = fromId;
  this.to_id = toId;
  this.amount = amount;
  this.type_id = typeId;
  this.description = description;
  this.tx_date = txDate;
}

module.exports = Transaction;
