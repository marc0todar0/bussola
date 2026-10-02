-- ============================================================================
-- 004 -- ETC as a holding type of its own
-- ============================================================================
-- An ETC (exchange traded commodity, e.g. a physical gold fund) is priced
-- like an ETF, but there was no type for it: people typed "ETC" into the
-- holding form, which makes a type with no code, and everything that is
-- decided by a type's code -- prices updated automatically, for one -- left
-- those holdings out.
--
-- ETC joins the shared taxonomy (wallet_id NULL, code 'ETC'). Holdings that
-- carry a type somebody typed under that name, in any wallet, move to it and
-- the typed type goes: the name would otherwise show up twice. Nothing else
-- about those holdings changes.
-- ============================================================================

-- nextval and not a fixed id: wallets may already have typed types that took
-- the numbers after the seeded ones.
INSERT INTO holding_types (id, name, color, code, wallet_id)
VALUES (nextval('seq_holding_types'), 'ETC', '#c9a227', 'ETC', NULL);

UPDATE holdings
   SET type_id = (SELECT id FROM holding_types WHERE code = 'ETC')
 WHERE type_id IN (SELECT id FROM holding_types
                    WHERE wallet_id IS NOT NULL AND lower(btrim(name)) = 'etc');

DELETE FROM holding_types WHERE wallet_id IS NOT NULL AND lower(btrim(name)) = 'etc';
