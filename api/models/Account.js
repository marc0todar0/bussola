// Both bank accounts and categories live in the same table; is_account tells
// them apart.
function Account(
  id,
  name,
  color,
  icon,
  iconFamily,
  amount,
  typeId,
  description,
  isAccount,
  actualAmount,
  isCurrent,
  isInvestment
) {
  this.id = id;
  this.name = name;
  this.color = color;
  this.icon = icon;
  this.icon_family = iconFamily;
  this.amount = amount;
  this.type_id = typeId;
  this.description = description;
  this.is_account = isAccount;
  this.actual_amount = actualAmount;
  this.is_current = isCurrent;
  this.is_investment = isInvestment;
}

module.exports = Account;
