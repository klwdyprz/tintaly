-- Run this in Supabase: SQL Editor > New query > Run

create table store_owners (
  owner_id serial primary key,
  username varchar(100) unique not null,
  full_name varchar(150) not null,
  password_hash varchar(255) not null,
  email varchar(150) not null,
  store_name varchar(150) not null
);

create table categories (
  category_id serial primary key,
  owner_id int not null references store_owners(owner_id) on delete cascade,
  category_name varchar(100) not null
);

create table customers (
  customer_id serial primary key,
  owner_id int not null references store_owners(owner_id) on delete cascade,
  full_name varchar(150) not null,
  contact_number varchar(50),
  balance numeric(12,2) not null default 0
);

create table products (
  product_id serial primary key,
  owner_id int not null references store_owners(owner_id) on delete cascade,
  category_id int references categories(category_id) on delete set null,
  product_name varchar(150) not null,
  price numeric(12,2) not null
);

create table transactions (
  transaction_id serial primary key,
  customer_id int not null references customers(customer_id) on delete cascade,
  transaction_type varchar(20) not null check (transaction_type in ('purchase','payment')),
  amount numeric(12,2) not null,
  transaction_date timestamp not null default now()
);

create table transaction__items (
  item_id serial primary key,
  transaction_id int not null references transactions(transaction_id) on delete cascade,
  product_id int not null references products(product_id),
  quantity int not null,
  unit_price numeric(12,2) not null,
  subtotal numeric(12,2) not null
);

create table balance_history (
  history_id serial primary key,
  customer_id int not null references customers(customer_id) on delete cascade,
  transaction_id int not null references transactions(transaction_id) on delete cascade,
  balance_before numeric(12,2) not null,
  balance_after numeric(12,2) not null,
  created_at timestamp not null default now()
);

create index on customers(owner_id);
create index on products(owner_id);
create index on transactions(customer_id);
