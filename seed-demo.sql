-- ============================================================================
-- DEMO dataset -- entirely fictional data (~20k portfolio)
-- ============================================================================
-- Assumes the schema already exists (the migrations run on their own the first
-- time the API starts) and that at least one account has been created.
--
-- Usage:
--   docker compose up -d          # creates the schema and the first user
--   set -a && source .env && set +a
--   docker exec -i bussola-postgres psql -U "$PGUSER" -d "$PGDATABASE" < seed-demo.sql
--
-- Contents:
--   - 6 current accounts (~19,830 EUR in total)
--   - 2 investment accounts with 9 holdings (Demo Broker, Safe Deposit)
--   - 16 expense categories
--   - 5 income categories
--   - 1 archived account + 2 archived categories
--   - ~86 transactions spread over the last four months (some today)
--   - 5 monthly portfolio snapshots (the last 5 months)
--
-- NOTE: institutions, issuers and ISINs are invented. The ISINs use the 'XX'
-- prefix, which ISO 6166 does not assign, so they match no real instrument.
-- Every holding has auto_update=false: the dataset triggers no call to an
-- external quote provider.
--
-- WHOSE DATA IS THIS: the rows go into the first wallet in `wallets`, and
-- everything that wallet already holds is deleted first, so loading the file
-- twice leaves the same result. Every other wallet is untouched -- the deletes
-- below filter on wallet_id explicitly, because psql connects as the table owner
-- and the owner is a superuser, which bypasses Row Level Security.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Whose data this is
-- ----------------------------------------------------------------------------
DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM wallets) THEN
        RAISE EXCEPTION 'No wallet exists yet. Start the stack, sign in once and '
                        'create a wallet, then load this file.';
    END IF;
END
$guard$;

-- Transaction-local: both disappear at COMMIT. The data tables default their
-- wallet_id from the first setting, which is why no INSERT below names the
-- column; created_by follows app.user_id the same way.
SELECT set_config('app.wallet_id', (SELECT id::text FROM wallets ORDER BY id LIMIT 1), true);
SELECT set_config('app.user_id',
                  (SELECT m.user_id::text FROM wallet_members m
                    WHERE m.wallet_id = current_setting('app.wallet_id')::int
                    ORDER BY m.user_id LIMIT 1), true);

-- Wipe what this wallet already holds, starting from the tables that reference
-- the others. Rows in any other wallet are out of scope by the wallet_id filter.
DELETE FROM transactions        WHERE wallet_id = current_setting('app.wallet_id')::int;
DELETE FROM holdings            WHERE wallet_id = current_setting('app.wallet_id')::int;
DELETE FROM portfolio_snapshots WHERE wallet_id = current_setting('app.wallet_id')::int;
DELETE FROM accounts            WHERE wallet_id = current_setting('app.wallet_id')::int;

-- Ids are assigned by the sequences and looked up by name, never hardcoded: a
-- fixed id would collide with another wallet's rows the moment this database
-- holds more than one wallet.
CREATE TEMP TABLE demo_account (name text PRIMARY KEY, id int) ON COMMIT DROP;
CREATE TEMP TABLE demo_holding (name text PRIMARY KEY, id int) ON COMMIT DROP;

-- ============================================================================
-- DEMO DATA
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Bank accounts (is_account = true, type STANDARD_ACCOUNT) -- ~19,830 EUR
-- ----------------------------------------------------------------------------
WITH ins AS (
    INSERT INTO accounts (id, name, color, icon, icon_family, amount, type_id, description, is_account, actual_amount)
    SELECT nextval('seq_accounts'), v.name, v.color, v.icon, v.icon_family, v.amount,
           (SELECT id FROM account_types WHERE code = 'STANDARD_ACCOUNT'),
           v.description, true, v.actual_amount
    FROM (VALUES
        ('Cartesio Bank', 'crimson',    'cc-mastercard',      'FontAwesome',            4500.00, 'Main current account', 4500.00),
        ('NeoCard',       'dodgerblue', 'credit-card-refund', 'MaterialCommunityIcons', 1200.00, 'Travel card',          1200.00),
        ('Savings Plus',  'seagreen',   'finance',            'MaterialCommunityIcons', 8500.00, 'Savings account',      9000.00),
        ('ETF Plan',      'darkorange', 'bitcoin',            'FontAwesome',            5000.00, 'ETF accumulation plan',4600.00),
        ('Cash',          'dimgray',    'dollar',             'FontAwesome',             350.00, 'Wallet',                350.00),
        ('Online Wallet', 'mediumblue', 'paypal',             'FontAwesome',             280.00, 'Online purchases',      280.00)
    ) AS v(name, color, icon, icon_family, amount, description, actual_amount)
    RETURNING id, name
)
INSERT INTO demo_account SELECT name, id FROM ins;

-- ----------------------------------------------------------------------------
-- Expense categories (is_account = false, type EXPENSE)
-- ----------------------------------------------------------------------------
WITH ins AS (
    INSERT INTO accounts (id, name, color, icon, icon_family, amount, type_id, description, is_account)
    SELECT nextval('seq_accounts'), v.name, v.color, v.icon, v.icon_family, NULL,
           (SELECT id FROM account_types WHERE code = 'EXPENSE'),
           v.description, false
    FROM (VALUES
        ('Groceries',        'olivedrab',     'shopping-cart',          'AntDesign',              'Food shopping'),
        ('Restaurant',       'tomato',        'restaurant',            'Ionicons',               'Eating out'),
        ('Coffee shops',     'sienna',        'fast-food',             'Ionicons',               'Breakfast and coffee'),
        ('Fuel',             'darkorange',    'gas-station',           'MaterialCommunityIcons', 'Petrol for the car'),
        ('Transport',        'steelblue',     'card-travel',           'MaterialIcons',          'Bus, train, taxi'),
        ('Utilities',        'goldenrod',     'finance',               'MaterialCommunityIcons', 'Electricity, gas, water'),
        ('Rent',             'rebeccapurple', 'form',                  'AntDesign',              'Monthly rent'),
        ('Phone & internet', 'dodgerblue',    'sim-card',              'MaterialIcons',          'Phone and broadband'),
        ('Subscriptions',    'crimson',       'spotify',               'Entypo',                 'Netflix, Spotify, etc.'),
        ('Health',           'firebrick',     'dots-three-horizontal', 'Entypo',                 'Pharmacy and doctors'),
        ('Clothing',         'hotpink',       'shopping-cart',          'AntDesign',              'Clothes and shoes'),
        ('Leisure',          'mediumpurple',  'beer',                  'FontAwesome',            'Cinema, drinks, events'),
        ('Online shopping',  'teal',          'shopping-cart',          'AntDesign',              'Amazon and the like'),
        ('Travel',           'darkturquoise', 'card-travel',           'MaterialIcons',          'Hotels, flights, weekends'),
        ('Sport',            'seagreen',      'people',                'Ionicons',               'Gym and gear'),
        ('Other expenses',   'dimgray',       'dots-three-horizontal', 'Entypo',                 'Odds and ends')
    ) AS v(name, color, icon, icon_family, description)
    RETURNING id, name
)
INSERT INTO demo_account SELECT name, id FROM ins;

-- ----------------------------------------------------------------------------
-- Income categories (is_account = false, type INCOME)
-- ----------------------------------------------------------------------------
WITH ins AS (
    INSERT INTO accounts (id, name, color, icon, icon_family, amount, type_id, description, is_account)
    SELECT nextval('seq_accounts'), v.name, v.color, v.icon, v.icon_family, NULL,
           (SELECT id FROM account_types WHERE code = 'INCOME'),
           v.description, false
    FROM (VALUES
        ('Salary',          'forestgreen', 'dollar',             'FontAwesome',            'Monthly salary'),
        ('Reimbursements',  'darkorange',  'credit-card-refund', 'MaterialCommunityIcons', 'Work expense refunds'),
        ('Investments',     'gold',        'finance',            'MaterialCommunityIcons', 'Dividends and coupons'),
        ('Gifts received',  'hotpink',     'euro',               'FontAwesome',            'Gifts and bonuses'),
        ('Other income',    'slategray',   'coins',              'FontAwesome5',           'Second-hand sales, etc.')
    ) AS v(name, color, icon, icon_family, description)
    RETURNING id, name
)
INSERT INTO demo_account SELECT name, id FROM ins;

-- ----------------------------------------------------------------------------
-- Investment accounts (is_investment = true, is_current = false)
--   amount        = invested capital (cost)
--   actual_amount = current value = sum of the linked holdings
-- ----------------------------------------------------------------------------
WITH ins AS (
    INSERT INTO accounts (id, name, color, icon, icon_family, amount, type_id, description, is_account, actual_amount, is_current, is_investment)
    SELECT nextval('seq_accounts'), v.name, v.color, v.icon, v.icon_family, v.amount,
           (SELECT id FROM account_types WHERE code = 'STANDARD_ACCOUNT'),
           v.description, true, v.actual_amount, false, true
    FROM (VALUES
        ('Demo Broker',  'darkorange', 'bitcoin', 'FontAwesome',            12000.00, 'Stock and ETF broker',        13750.00),
        ('Safe Deposit', 'seagreen',   'finance', 'MaterialCommunityIcons',  6800.00, 'Locked interest-bearing cash', 7000.00)
    ) AS v(name, color, icon, icon_family, amount, description, actual_amount)
    RETURNING id, name
)
INSERT INTO demo_account SELECT name, id FROM ins;

-- ----------------------------------------------------------------------------
-- Holdings of the investment accounts. The sum per account has to match
-- accounts.actual_amount (Demo Broker 13,750, Safe Deposit 7,000).
-- amount = quantity * current_price; the return is derived from
-- (current_price - purchase_price) / purchase_price. Pillars and holding types
-- are looked up by code, never by name: the name follows the interface
-- language, the code does not. For crypto the isin field carries the quote
-- symbol (e.g. BTC-EUR). Deposit accounts have auto_update = false.
-- ----------------------------------------------------------------------------
WITH ins AS (
    INSERT INTO holdings (id, account_id, name, pillar_id, amount, description, type_id, issuer, country, currency, isin, quantity, purchase_price, purchase_date, current_price, auto_update)
    SELECT nextval('seq_holdings'), a.id, v.name,
           (SELECT id FROM pillars WHERE code = v.pillar_code),
           v.amount, v.description,
           (SELECT id FROM holding_types WHERE code = v.type_code),
           v.issuer, v.country, v.currency, v.isin,
           v.quantity, v.purchase_price, v.purchase_date, v.current_price, false
    FROM (VALUES
        ('Demo Broker',  'Global Equity',        'LONG_TERM',        6500.00, 'Global equity ETF',   'ETF',             'Global Index',      'Global', 'USD', 'XX0000000001',  50.0000::numeric,   120.00::numeric, '2023-03-10'::date,   130.00::numeric),
        ('Demo Broker',  'US Equity',            'LONG_TERM',        3100.00, 'US equity ETF',       'ETF',             'Core Funds',        'US',     'USD', 'XX0000000002',   6.2000,            445.00,          '2022-06-20',         500.00),
        ('Demo Broker',  'Japan Equity',         'LONG_TERM',         700.00, 'Japan equity ETF',    'ETF',             'Pacific Funds',     'Japan',  'JPY', 'XX0000000003',  35.0000,             19.20,          '2025-01-15',          20.00),
        ('Demo Broker',  'Government Bond 2028', 'PLANNED_EXPENSES', 2500.00, 'Government bond',     'BTP',             'National Treasury', 'Italy',  'EUR', 'XX0000000004',  25.0000,             98.50,          '2024-09-01',         100.00),
        ('Demo Broker',  'Bitcoin',              'LONG_TERM',         600.00, 'Cryptocurrency',      'CRYPTO',          NULL,                'Global', 'USD', 'BTC-EUR',        0.0100,          49000.00,          '2021-11-05',       60000.00),
        ('Demo Broker',  'Ethereum',             'LONG_TERM',         250.00, 'Cryptocurrency',      'CRYPTO',          NULL,                'Global', 'USD', 'ETH-EUR',        0.1000,           2175.00,          '2024-02-20',        2500.00),
        ('Demo Broker',  'USDC',                 'LONG_TERM',         100.00, 'Stablecoin',          'CRYPTO',          NULL,                'Global', 'USD', NULL,           100.0000,              1.00,          '2025-05-01',           1.00),
        ('Safe Deposit', '12-month deposit',     'EMERGENCY_FUND',   5000.00, 'Interest-bearing emergency fund', 'DEPOSIT_ACCOUNT', 'Safe Deposit', 'Italy', 'EUR', NULL,       NULL,               NULL,            NULL,                 NULL),
        ('Safe Deposit', '24-month deposit',     'PLANNED_EXPENSES', 2000.00, 'Long-term locked cash',           'DEPOSIT_ACCOUNT', 'Safe Deposit', 'Italy', 'EUR', NULL,       NULL,               NULL,            NULL,                 NULL)
    ) AS v(account, name, pillar_code, amount, description, type_code, issuer, country, currency, isin, quantity, purchase_price, purchase_date, current_price)
    JOIN demo_account a ON a.name = v.account
    RETURNING id, name
)
INSERT INTO demo_holding SELECT name, id FROM ins;

-- ----------------------------------------------------------------------------
-- Archived account and categories -- outside the active views.
--   Note: an account can only be archived at a zero balance.
-- ----------------------------------------------------------------------------
INSERT INTO accounts (id, name, color, icon, icon_family, amount, type_id, description, is_account, actual_amount, archived)
VALUES (nextval('seq_accounts'), 'Closed Account', 'dimgray', 'cc-mastercard', 'FontAwesome', 0.00,
        (SELECT id FROM account_types WHERE code = 'STANDARD_ACCOUNT'),
        'Old closed account', true, 0.00, true);

INSERT INTO accounts (id, name, color, icon, icon_family, amount, type_id, description, is_account, archived)
SELECT nextval('seq_accounts'), v.name, v.color, v.icon, v.icon_family, NULL,
       (SELECT id FROM account_types WHERE code = v.type_code),
       v.description, false, true
FROM (VALUES
    ('Cigarettes', 'dimgray',   'dots-three-horizontal', 'Entypo',                 'EXPENSE', 'Discontinued category'),
    ('Cashback',   'slategray', 'credit-card-refund',    'MaterialCommunityIcons', 'INCOME',  'Old card cashback')
) AS v(name, color, icon, icon_family, type_code, description);

-- ----------------------------------------------------------------------------
-- Transactions
--   EXPENSE  = from an account -> to an expense category
--   INCOME   = from an income category -> to an account   (from_id is the account)
--   TRANSFER = from an account -> to an account
--
-- Dates are anchored to CURRENT_DATE: past months are computed with
-- DATE_TRUNC('month', CURRENT_DATE) - INTERVAL 'N months' and recent days with
-- CURRENT_DATE - INTERVAL 'N days', so the dataset stays current whatever
-- today's date happens to be.
-- ----------------------------------------------------------------------------
INSERT INTO transactions (id, from_id, to_id, amount, type_id, description, tx_date)
SELECT nextval('seq_transactions'), f.id, t.id, v.amount,
       (SELECT id FROM transaction_types WHERE code = v.type_code),
       v.description, v.tx_date
FROM (VALUES
    -- 3 months ago
    ('Cartesio Bank', 'Salary',           2200.00, 'INCOME',   'Salary',              DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL  '0 days  9 hours'),
    ('Cartesio Bank', 'Rent',              650.00, 'EXPENSE',  'Rent',                DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL  '0 days 10 hours'),
    ('Cartesio Bank', 'Utilities',          88.00, 'EXPENSE',  'Electricity bill',    DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL  '1 days 11 hours'),
    ('Cartesio Bank', 'Utilities',         132.00, 'EXPENSE',  'Gas bill',            DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL  '2 days 11 hours'),
    ('Cartesio Bank', 'Groceries',          54.30, 'EXPENSE',  'Weekly shop',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL  '3 days 18 hours 30 minutes'),
    ('Cartesio Bank', 'Restaurant',         30.00, 'EXPENSE',  'Dinner with friends', DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL  '5 days 21 hours'),
    ('Cartesio Bank', 'Savings Plus',      500.00, 'TRANSFER', 'Monthly saving',      DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL  '7 days 11 hours'),
    ('Cartesio Bank', 'Groceries',          63.20, 'EXPENSE',  'Weekly shop',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL  '9 days 18 hours'),
    ('Cartesio Bank', 'Clothing',           45.00, 'EXPENSE',  'Present',             DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL '11 days 15 hours'),
    ('Cartesio Bank', 'Restaurant',         55.00, 'EXPENSE',  'Dinner out',          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL '13 days 20 hours 30 minutes'),
    ('Cartesio Bank', 'Phone & internet',   12.99, 'EXPENSE',  'Phone plan',          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL '14 days  9 hours'),
    ('Cash',          'Coffee shops',        2.50, 'EXPENSE',  'Coffee and pastry',   DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL '17 days  8 hours 15 minutes'),
    ('Cartesio Bank', 'Fuel',               58.00, 'EXPENSE',  'Full tank',           DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL '19 days 14 hours'),
    ('Cartesio Bank', 'Sport',              45.00, 'EXPENSE',  'Gym membership',      DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL '21 days  9 hours'),
    ('Cartesio Bank', 'Groceries',          47.10, 'EXPENSE',  'Weekly shop',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL '24 days 18 hours'),
    ('Cartesio Bank', 'Restaurant',         12.00, 'EXPENSE',  'Work lunch',          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL '26 days 13 hours'),
    ('Cartesio Bank', 'Reimbursements',     95.00, 'INCOME',   'Mileage refund',      DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL '27 days 11 hours'),
    ('Cartesio Bank', 'Subscriptions',      15.99, 'EXPENSE',  'Netflix',             DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months' + INTERVAL '27 days 12 hours'),
    -- 2 months ago
    ('Cartesio Bank', 'Salary',           2200.00, 'INCOME',   'Salary',              DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL  '0 days  9 hours'),
    ('Cartesio Bank', 'Rent',              650.00, 'EXPENSE',  'Rent',                DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL  '0 days 10 hours'),
    ('Cartesio Bank', 'Utilities',          92.00, 'EXPENSE',  'Electricity bill',    DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL  '1 days 11 hours'),
    ('Cartesio Bank', 'Utilities',         125.00, 'EXPENSE',  'Gas bill',            DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL  '2 days 11 hours'),
    ('Cartesio Bank', 'Groceries',          58.40, 'EXPENSE',  'Weekly shop',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL  '3 days 18 hours'),
    ('Cash',          'Restaurant',         10.00, 'EXPENSE',  'Work lunch',          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL  '4 days 13 hours'),
    ('Cartesio Bank', 'Leisure',            16.00, 'EXPENSE',  'Cinema',              DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL  '5 days 21 hours'),
    ('Cartesio Bank', 'Savings Plus',      500.00, 'TRANSFER', 'Monthly saving',      DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL  '7 days 11 hours'),
    ('Cartesio Bank', 'Fuel',               60.00, 'EXPENSE',  'Full tank',           DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL  '9 days 15 hours'),
    ('Cartesio Bank', 'Health',             80.00, 'EXPENSE',  'Doctor visit',        DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL '11 days 10 hours'),
    ('Cartesio Bank', 'Phone & internet',   12.99, 'EXPENSE',  'Phone plan',          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL '14 days  9 hours'),
    ('Cartesio Bank', 'Groceries',          71.80, 'EXPENSE',  'Weekly shop',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL '17 days 18 hours 30 minutes'),
    ('NeoCard',       'Restaurant',         42.00, 'EXPENSE',  'Dinner out',          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL '19 days 20 hours 30 minutes'),
    ('Cartesio Bank', 'Sport',              45.00, 'EXPENSE',  'Gym membership',      DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL '21 days  9 hours'),
    ('Online Wallet', 'Online shopping',    67.00, 'EXPENSE',  'Amazon order',        DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL '22 days 14 hours'),
    ('Cartesio Bank', 'Reimbursements',    110.00, 'INCOME',   'Mileage refund',      DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL '24 days 11 hours'),
    ('Cartesio Bank', 'Groceries',          49.30, 'EXPENSE',  'Weekly shop',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL '27 days 18 hours'),
    ('Cartesio Bank', 'Subscriptions',      15.99, 'EXPENSE',  'Netflix',             DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL '28 days 12 hours'),
    ('Online Wallet', 'Other income',       85.00, 'INCOME',   'Sold used books',     DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months' + INTERVAL '29 days 11 hours'),
    -- 1 month ago
    ('Cartesio Bank', 'Salary',           2200.00, 'INCOME',   'Salary',              DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '0 days  9 hours'),
    ('Cartesio Bank', 'Rent',              650.00, 'EXPENSE',  'Rent',                DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '0 days 10 hours'),
    ('Cartesio Bank', 'Utilities',          78.00, 'EXPENSE',  'Electricity bill',    DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '1 days 11 hours'),
    ('Cartesio Bank', 'Utilities',         110.00, 'EXPENSE',  'Gas bill',            DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '2 days 11 hours'),
    ('Cartesio Bank', 'Groceries',          55.00, 'EXPENSE',  'Weekly shop',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '3 days 18 hours'),
    ('NeoCard',       'Restaurant',         38.00, 'EXPENSE',  'Sunday lunch',        DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '4 days 13 hours 30 minutes'),
    ('Cartesio Bank', 'Fuel',               52.00, 'EXPENSE',  'Petrol',              DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '5 days 13 hours'),
    ('Cartesio Bank', 'Leisure',            22.00, 'EXPENSE',  'Cinema with friends', DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '6 days 21 hours'),
    ('Cartesio Bank', 'Phone & internet',   12.99, 'EXPENSE',  'Phone plan',          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '7 days  9 hours'),
    ('Cartesio Bank', 'Groceries',          68.30, 'EXPENSE',  'Weekly shop',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '8 days 18 hours 30 minutes'),
    ('Cash',          'Restaurant',          8.50, 'EXPENSE',  'Quick lunch',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL  '9 days 13 hours'),
    ('Cartesio Bank', 'Savings Plus',      500.00, 'TRANSFER', 'Monthly saving',      DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '10 days 11 hours'),
    ('Online Wallet', 'Clothing',           89.00, 'EXPENSE',  'Jumper and shirt',    DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '11 days 15 hours'),
    ('Cartesio Bank', 'Transport',          38.00, 'EXPENSE',  'Bus pass',            DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '13 days  9 hours'),
    ('Cartesio Bank', 'Health',             24.00, 'EXPENSE',  'Pharmacy',            DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '14 days 10 hours'),
    ('Cartesio Bank', 'Groceries',          52.00, 'EXPENSE',  'Weekly shop',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '16 days 18 hours'),
    ('Cartesio Bank', 'Restaurant',         35.00, 'EXPENSE',  'Dinner out',          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '17 days 20 hours 30 minutes'),
    ('Cartesio Bank', 'Leisure',            18.00, 'EXPENSE',  'Drinks',              DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '18 days 19 hours'),
    ('Cartesio Bank', 'Reimbursements',    135.00, 'INCOME',   'Mileage refund',      DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '19 days 11 hours'),
    ('Cartesio Bank', 'Sport',              45.00, 'EXPENSE',  'Gym membership',      DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '21 days  9 hours'),
    ('Cartesio Bank', 'Travel',            180.00, 'EXPENSE',  'Weekend at the sea',  DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '24 days 12 hours'),
    ('Online Wallet', 'Clothing',           32.00, 'EXPENSE',  'Swimsuit',            DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '25 days 16 hours'),
    ('Cartesio Bank', 'Coffee shops',        2.20, 'EXPENSE',  'Coffee',              DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '26 days  8 hours 30 minutes'),
    ('Cartesio Bank', 'Groceries',          45.00, 'EXPENSE',  'Weekly shop',         DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '27 days 18 hours'),
    ('Cartesio Bank', 'Subscriptions',      15.99, 'EXPENSE',  'Netflix',             DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '28 days 12 hours'),
    ('ETF Plan',      'Investments',        45.00, 'INCOME',   'ETF dividends Q1',    DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'  + INTERVAL '29 days 16 hours'),
    -- Current month: salary/rent/bill pinned to the 1st
    ('Cartesio Bank', 'Salary',           2200.00, 'INCOME',   'Salary',              DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '0 days  9 hours'),
    ('Cartesio Bank', 'Rent',              650.00, 'EXPENSE',  'Rent',                DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '0 days 10 hours'),
    ('Cartesio Bank', 'Utilities',          85.00, 'EXPENSE',  'Electricity bill',    DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 days 11 hours'),
    -- Recent days (relative to today)
    ('Cartesio Bank', 'Groceries',          62.40, 'EXPENSE',  'Weekly shop',         CURRENT_DATE - INTERVAL '10 days' + INTERVAL '18 hours 30 minutes'),
    ('NeoCard',       'Restaurant',         22.00, 'EXPENSE',  'Lunch out',           CURRENT_DATE - INTERVAL  '9 days' + INTERVAL '13 hours'),
    ('Cartesio Bank', 'Coffee shops',        2.20, 'EXPENSE',  'Coffee on the run',   CURRENT_DATE - INTERVAL  '8 days' + INTERVAL  '8 hours 15 minutes'),
    ('Cartesio Bank', 'Restaurant',         45.00, 'EXPENSE',  'Dinner with friends', CURRENT_DATE - INTERVAL  '8 days' + INTERVAL '21 hours'),
    ('Cartesio Bank', 'Fuel',               55.00, 'EXPENSE',  'Full tank',           CURRENT_DATE - INTERVAL  '7 days' + INTERVAL '12 hours'),
    ('Cartesio Bank', 'Subscriptions',      15.99, 'EXPENSE',  'Netflix',             CURRENT_DATE - INTERVAL  '7 days' + INTERVAL '19 hours'),
    ('Cartesio Bank', 'Savings Plus',      500.00, 'TRANSFER', 'Monthly saving',      CURRENT_DATE - INTERVAL  '6 days' + INTERVAL '11 hours'),
    ('Online Wallet', 'Subscriptions',      10.99, 'EXPENSE',  'Spotify',             CURRENT_DATE - INTERVAL  '5 days' + INTERVAL '13 hours'),
    ('Cartesio Bank', 'Leisure',            18.00, 'EXPENSE',  'Cinema',              CURRENT_DATE - INTERVAL  '5 days' + INTERVAL '21 hours'),
    ('Cartesio Bank', 'Reimbursements',    120.00, 'INCOME',   'Mileage refund',      CURRENT_DATE - INTERVAL  '4 days' + INTERVAL '11 hours'),
    ('Cartesio Bank', 'Groceries',          38.50, 'EXPENSE',  'Quick shop',          CURRENT_DATE - INTERVAL  '4 days' + INTERVAL '18 hours'),
    ('Cartesio Bank', 'Sport',              45.00, 'EXPENSE',  'Gym membership',      CURRENT_DATE - INTERVAL  '3 days' + INTERVAL  '9 hours'),
    ('Cash',          'Restaurant',         12.00, 'EXPENSE',  'Quick lunch',         CURRENT_DATE - INTERVAL  '3 days' + INTERVAL '13 hours 30 minutes'),
    ('Cash',          'Coffee shops',        2.50, 'EXPENSE',  'Coffee',              CURRENT_DATE - INTERVAL  '2 days' + INTERVAL  '8 hours 30 minutes'),
    ('Online Wallet', 'Clothing',           29.90, 'EXPENSE',  'T-shirt',             CURRENT_DATE - INTERVAL  '2 days' + INTERVAL '19 hours'),
    ('Cartesio Bank', 'Coffee shops',        2.20, 'EXPENSE',  'Coffee',              CURRENT_DATE - INTERVAL  '1 day'  + INTERVAL  '8 hours 30 minutes'),
    ('Online Wallet', 'Restaurant',         28.50, 'EXPENSE',  'Sushi dinner',        CURRENT_DATE - INTERVAL  '1 day'  + INTERVAL '21 hours'),
    -- Today
    ('Cartesio Bank', 'Coffee shops',        3.50, 'EXPENSE',  'Coffee and croissant',CURRENT_DATE                      + INTERVAL  '8 hours 30 minutes'),
    ('Cartesio Bank', 'Restaurant',         12.50, 'EXPENSE',  'Lunch at the bar',    CURRENT_DATE                      + INTERVAL '13 hours'),
    ('Cartesio Bank', 'Groceries',          47.80, 'EXPENSE',  'Evening shop',        CURRENT_DATE                      + INTERVAL '18 hours 30 minutes')
) AS v(from_name, to_name, amount, type_code, description, tx_date)
JOIN demo_account f ON f.name = v.from_name
JOIN demo_account t ON t.name = v.to_name;

-- ----------------------------------------------------------------------------
-- Portfolio snapshots: the last 5 months, ONE row per period.
-- Year and month are derived from the current month so the history stays
-- current. The values grow towards the present allocation.
-- The frozen `detail` (diversification + accounts/holdings) is DERIVED from the
-- per-pillar values (p1..p4) with fixed fractions, so every donut and every
-- account adds up consistently with that month's total/value_pN.
--   p1 = Cash · p2 = Emergency fund · p3 = Planned expenses · p4 = Long term
-- Its shape mirrors what buildDetail() in portfolio_controller.js produces:
-- the same diversification keys, and {name, code, color, value} per slice.
-- ----------------------------------------------------------------------------
INSERT INTO portfolio_snapshots (id, year, month, total, value_p1, value_p2, value_p3, value_p4, detail)
SELECT nextval('seq_portfolio_snapshots'), EXTRACT(YEAR  FROM DATE_TRUNC('month', CURRENT_DATE) - (s.moff::text || ' months')::interval)::int,
       EXTRACT(MONTH FROM DATE_TRUNC('month', CURRENT_DATE) - (s.moff::text || ' months')::interval)::int,
       s.p1 + s.p2 + s.p3 + s.p4,
       s.p1, s.p2, s.p3, s.p4,
       jsonb_build_object(
         'diversification', jsonb_build_object(
           'type', jsonb_build_object(
             'total', round((s.p1 + s.p2 + s.p3 + s.p4)::numeric, 2),
             'data', jsonb_build_array(
               jsonb_build_object('name','Cash',            'code','CASH',            'color','#90a4ae','value', round(s.p1::numeric, 2)),
               jsonb_build_object('name','ETF',             'code','ETF',             'color','#26a69a','value', round((0.916 * s.p4)::numeric, 2)),
               jsonb_build_object('name','Deposit account', 'code','DEPOSIT_ACCOUNT', 'color','#66bb6a','value', round((s.p2 + 0.444 * s.p3)::numeric, 2)),
               jsonb_build_object('name','BTP',             'code','BTP',             'color','#ffb74d','value', round((0.556 * s.p3)::numeric, 2)),
               jsonb_build_object('name','Crypto',          'code','CRYPTO',          'color','#ffca28','value', round((0.084 * s.p4)::numeric, 2))
             )),
           'broker', jsonb_build_object(
             'total', round((s.p2 + s.p3 + s.p4)::numeric, 2),
             'data', jsonb_build_array(
               jsonb_build_object('name','Demo Broker', 'code', NULL, 'color','darkorange','value', round((s.p4 + 0.556 * s.p3)::numeric, 2)),
               jsonb_build_object('name','Safe Deposit','code', NULL, 'color','seagreen',  'value', round((s.p2 + 0.444 * s.p3)::numeric, 2))
             )),
           'issuer_etf', jsonb_build_object(
             'total', round((0.916 * s.p4)::numeric, 2),
             'data', jsonb_build_array(
               jsonb_build_object('name','Global Index', 'code', NULL, 'color', NULL, 'value', round((0.578 * s.p4)::numeric, 2)),
               jsonb_build_object('name','Core Funds',   'code', NULL, 'color', NULL, 'value', round((0.276 * s.p4)::numeric, 2)),
               jsonb_build_object('name','Pacific Funds','code', NULL, 'color', NULL, 'value', round((0.062 * s.p4)::numeric, 2))
             )),
           'bond_country', jsonb_build_object(
             'total', round(s.p3::numeric, 2),
             'data', jsonb_build_array(
               jsonb_build_object('name','Italy','code', NULL, 'color', NULL, 'value', round(s.p3::numeric, 2))
             )),
           'bond_issuer', jsonb_build_object(
             'total', round(s.p3::numeric, 2),
             'data', jsonb_build_array(
               jsonb_build_object('name','National Treasury','code', NULL, 'color', NULL, 'value', round((0.556 * s.p3)::numeric, 2)),
               jsonb_build_object('name','Safe Deposit',     'code', NULL, 'color', NULL, 'value', round((0.444 * s.p3)::numeric, 2))
             )),
           'equity_country', jsonb_build_object(
             'total', round(s.p4::numeric, 2),
             'data', jsonb_build_array(
               jsonb_build_object('name','Global','code', NULL, 'color', NULL, 'value', round((0.662 * s.p4)::numeric, 2)),
               jsonb_build_object('name','US',    'code', NULL, 'color', NULL, 'value', round((0.276 * s.p4)::numeric, 2)),
               jsonb_build_object('name','Japan', 'code', NULL, 'color', NULL, 'value', round((0.062 * s.p4)::numeric, 2))
             )),
           'equity_issuer', jsonb_build_object(
             'total', round(s.p4::numeric, 2),
             'data', jsonb_build_array(
               jsonb_build_object('name','Global Index', 'code', NULL, 'color', NULL, 'value', round((0.578 * s.p4)::numeric, 2)),
               jsonb_build_object('name','Core Funds',   'code', NULL, 'color', NULL, 'value', round((0.276 * s.p4)::numeric, 2)),
               jsonb_build_object('name','Pacific Funds','code', NULL, 'color', NULL, 'value', round((0.062 * s.p4)::numeric, 2)),
               -- A null name is an unfilled field: the interface labels it in
               -- the reader's own language rather than freezing a word here.
               jsonb_build_object('name', NULL,          'code', NULL, 'color', NULL, 'value', round((0.084 * s.p4)::numeric, 2))
             )),
           'equity_currency', jsonb_build_object(
             'total', round(s.p4::numeric, 2),
             'data', jsonb_build_array(
               jsonb_build_object('name','USD','code', NULL, 'color', NULL, 'value', round((0.938 * s.p4)::numeric, 2)),
               jsonb_build_object('name','JPY','code', NULL, 'color', NULL, 'value', round((0.062 * s.p4)::numeric, 2))
             )),
           'crypto', jsonb_build_object(
             'total', round((0.084 * s.p4)::numeric, 2),
             'data', jsonb_build_array(
               jsonb_build_object('name','Bitcoin', 'code', NULL, 'color', NULL, 'value', round((0.053 * s.p4)::numeric, 2)),
               jsonb_build_object('name','Ethereum','code', NULL, 'color', NULL, 'value', round((0.022 * s.p4)::numeric, 2)),
               jsonb_build_object('name','USDC',    'code', NULL, 'color', NULL, 'value', round((0.009 * s.p4)::numeric, 2))
             ))
         ),
         'accounts', jsonb_build_array(
           jsonb_build_object('id', a_savings.id, 'name','Savings Plus', 'color','seagreen',  'icon','finance',      'icon_family','MaterialCommunityIcons','type_code','STANDARD_ACCOUNT','type_name','Standard account','is_investment',false,'is_current',true,'amount', round((0.45 * s.p1)::numeric, 2),'actual_amount', round((0.45 * s.p1)::numeric, 2),'holdings', jsonb_build_array()),
           jsonb_build_object('id', a_bank.id,    'name','Cartesio Bank','color','crimson',   'icon','cc-mastercard','icon_family','FontAwesome',           'type_code','STANDARD_ACCOUNT','type_name','Standard account','is_investment',false,'is_current',true,'amount', round((0.23 * s.p1)::numeric, 2),'actual_amount', round((0.23 * s.p1)::numeric, 2),'holdings', jsonb_build_array()),
           jsonb_build_object('id', a_etf.id,     'name','ETF Plan',     'color','darkorange','icon','bitcoin',      'icon_family','FontAwesome',           'type_code','STANDARD_ACCOUNT','type_name','Standard account','is_investment',false,'is_current',true,'amount', round((0.23 * s.p1)::numeric, 2),'actual_amount', round((0.23 * s.p1)::numeric, 2),'holdings', jsonb_build_array()),
           jsonb_build_object('id', a_neo.id,     'name','NeoCard',      'color','dodgerblue','icon','credit-card-refund','icon_family','MaterialCommunityIcons','type_code','STANDARD_ACCOUNT','type_name','Standard account','is_investment',false,'is_current',true,'amount', round((0.06 * s.p1)::numeric, 2),'actual_amount', round((0.06 * s.p1)::numeric, 2),'holdings', jsonb_build_array()),
           jsonb_build_object('id', a_cash.id,    'name','Cash',         'color','dimgray',   'icon','dollar',       'icon_family','FontAwesome',           'type_code','STANDARD_ACCOUNT','type_name','Standard account','is_investment',false,'is_current',true,'amount', round((0.02 * s.p1)::numeric, 2),'actual_amount', round((0.02 * s.p1)::numeric, 2),'holdings', jsonb_build_array()),
           jsonb_build_object('id', a_wallet.id,  'name','Online Wallet','color','mediumblue','icon','paypal',       'icon_family','FontAwesome',           'type_code','STANDARD_ACCOUNT','type_name','Standard account','is_investment',false,'is_current',true,'amount', round((0.01 * s.p1)::numeric, 2),'actual_amount', round((0.01 * s.p1)::numeric, 2),'holdings', jsonb_build_array()),
           jsonb_build_object('id', a_broker.id, 'name','Demo Broker','color','darkorange','icon','bitcoin','icon_family','FontAwesome','type_code','STANDARD_ACCOUNT','type_name','Standard account','is_investment',true,'is_current',false,
             -- amount (cost) = sum of the holdings' costs; actual = current value
             'amount', round((0.578*s.p4*120.0/130.0 + 0.276*s.p4*445.0/500.0 + 0.062*s.p4*19.20/20.0
                              + 0.556*s.p3*98.5/100.0 + 0.053*s.p4*49000.0/60000.0 + 0.022*s.p4*2175.0/2500.0
                              + 0.009*s.p4)::numeric, 2),
             'actual_amount', round((s.p4 + 0.556 * s.p3)::numeric, 2),
             'holdings', jsonb_build_array(
               jsonb_build_object('id', h_global.id,'name','Global Equity',       'type_name','ETF','type_code','ETF','amount', round((0.578 * s.p4)::numeric, 2),'cost', round((0.578*s.p4*120.0/130.0)::numeric, 2),    'total_return', 8.33,  'purchase_date','2023-03-10'),
               jsonb_build_object('id', h_us.id,    'name','US Equity',           'type_name','ETF','type_code','ETF','amount', round((0.276 * s.p4)::numeric, 2),'cost', round((0.276*s.p4*445.0/500.0)::numeric, 2),    'total_return', 12.36, 'purchase_date','2022-06-20'),
               jsonb_build_object('id', h_bond.id,  'name','Government Bond 2028','type_name','BTP','type_code','BTP','amount', round((0.556 * s.p3)::numeric, 2),'cost', round((0.556*s.p3*98.5/100.0)::numeric, 2),     'total_return', 1.52,  'purchase_date','2024-09-01'),
               jsonb_build_object('id', h_jp.id,    'name','Japan Equity',        'type_name','ETF','type_code','ETF','amount', round((0.062 * s.p4)::numeric, 2),'cost', round((0.062*s.p4*19.20/20.0)::numeric, 2),     'total_return', 4.17,  'purchase_date','2025-01-15'),
               jsonb_build_object('id', h_btc.id,   'name','Bitcoin', 'type_name','Crypto','type_code','CRYPTO','amount', round((0.053 * s.p4)::numeric, 2),'cost', round((0.053*s.p4*49000.0/60000.0)::numeric, 2),'total_return', 22.45, 'purchase_date','2021-11-05'),
               jsonb_build_object('id', h_eth.id,   'name','Ethereum','type_name','Crypto','type_code','CRYPTO','amount', round((0.022 * s.p4)::numeric, 2),'cost', round((0.022*s.p4*2175.0/2500.0)::numeric, 2),  'total_return', 14.94, 'purchase_date','2024-02-20'),
               jsonb_build_object('id', h_usdc.id,  'name','USDC',    'type_name','Crypto','type_code','CRYPTO','amount', round((0.009 * s.p4)::numeric, 2),'cost', round((0.009*s.p4)::numeric, 2),                'total_return', 0.00,  'purchase_date','2025-05-01')
             )),
           jsonb_build_object('id', a_deposit.id,'name','Safe Deposit','color','seagreen','icon','finance','icon_family','MaterialCommunityIcons','type_code','STANDARD_ACCOUNT','type_name','Standard account','is_investment',true,'is_current',false,
             'amount', round((s.p2 + 0.444 * s.p3)::numeric, 2),'actual_amount', round((s.p2 + 0.444 * s.p3)::numeric, 2),
             'holdings', jsonb_build_array(
               jsonb_build_object('id', h_d12.id,'name','12-month deposit','type_name','Deposit account','type_code','DEPOSIT_ACCOUNT','amount', round(s.p2::numeric, 2),          'cost', round(s.p2::numeric, 2),          'total_return', NULL, 'purchase_date', NULL),
               jsonb_build_object('id', h_d24.id,'name','24-month deposit','type_name','Deposit account','type_code','DEPOSIT_ACCOUNT','amount', round((0.444 * s.p3)::numeric, 2),'cost', round((0.444 * s.p3)::numeric, 2),'total_return', NULL, 'purchase_date', NULL)
             ))
         )
       )
FROM (VALUES
    -- 5 months ago
    (5, 18000.00, 4000.00, 3500.00,  8500.00),
    -- 4 months ago
    (4, 18500.00, 4200.00, 3800.00,  9200.00),
    -- 3 months ago
    (3, 19000.00, 4500.00, 4000.00,  9800.00),
    -- 2 months ago
    (2, 19300.00, 4800.00, 4200.00, 10400.00),
    -- 1 month ago
    (1, 19700.00, 5000.00, 4400.00, 10900.00)
) AS s(moff, p1, p2, p3, p4)
CROSS JOIN (SELECT id FROM demo_account WHERE name = 'Savings Plus')  AS a_savings
CROSS JOIN (SELECT id FROM demo_account WHERE name = 'Cartesio Bank') AS a_bank
CROSS JOIN (SELECT id FROM demo_account WHERE name = 'ETF Plan')      AS a_etf
CROSS JOIN (SELECT id FROM demo_account WHERE name = 'NeoCard')       AS a_neo
CROSS JOIN (SELECT id FROM demo_account WHERE name = 'Cash')          AS a_cash
CROSS JOIN (SELECT id FROM demo_account WHERE name = 'Online Wallet') AS a_wallet
CROSS JOIN (SELECT id FROM demo_account WHERE name = 'Demo Broker')   AS a_broker
CROSS JOIN (SELECT id FROM demo_account WHERE name = 'Safe Deposit')  AS a_deposit
CROSS JOIN (SELECT id FROM demo_holding WHERE name = 'Global Equity')        AS h_global
CROSS JOIN (SELECT id FROM demo_holding WHERE name = 'US Equity')            AS h_us
CROSS JOIN (SELECT id FROM demo_holding WHERE name = 'Japan Equity')         AS h_jp
CROSS JOIN (SELECT id FROM demo_holding WHERE name = 'Government Bond 2028') AS h_bond
CROSS JOIN (SELECT id FROM demo_holding WHERE name = 'Bitcoin')              AS h_btc
CROSS JOIN (SELECT id FROM demo_holding WHERE name = 'Ethereum')             AS h_eth
CROSS JOIN (SELECT id FROM demo_holding WHERE name = 'USDC')                 AS h_usdc
CROSS JOIN (SELECT id FROM demo_holding WHERE name = '12-month deposit')     AS h_d12
CROSS JOIN (SELECT id FROM demo_holding WHERE name = '24-month deposit')     AS h_d24;

COMMIT;
