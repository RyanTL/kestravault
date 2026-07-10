-- Expose the JWT secret/expiry to Postgres (PostgREST and RLS helpers read
-- these GUCs). Values come from .env; runs once on first boot.
\set jwt_secret `echo "$JWT_SECRET"`
\set jwt_exp `echo "$JWT_EXP"`

alter database postgres set "app.settings.jwt_secret" to :'jwt_secret';
alter database postgres set "app.settings.jwt_exp" to :'jwt_exp';
