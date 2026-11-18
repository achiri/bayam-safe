-- PostgreSQL Escrow & Double-Entry Accounting Schema
-- Target: Cameroon Social Commerce ("Bayam-Sellam") Trust Layer

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users / Parties (Sellers, Buyers, Moto Riders, Admin)
CREATE TYPE user_role AS ENUM ('SELLER', 'BUYER', 'RIDER', 'ADMIN');

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id BIGINT UNIQUE,
    phone_number VARCHAR(20) NOT NULL, -- Cameroon format: e.g., 237670000000 (MTN) or 237690000000 (Orange)
    full_name VARCHAR(100) NOT NULL,
    role user_role NOT NULL DEFAULT 'BUYER',
    preferred_language VARCHAR(5) DEFAULT 'fr', -- 'fr' or 'en'
    is_verified_merchant BOOLEAN DEFAULT FALSE,
    verified_badge_expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Double-Entry Accounting Ledger (Prevents balance inconsistencies and race conditions)
CREATE TYPE account_type AS ENUM (
    'ESCROW_HOLDING_POOL',      -- Liability: Custodial funds held on behalf of buyers/sellers
    'SELLER_AVAILABLE_BALANCE',  -- Liability: Funds owed to seller after delivery confirmation
    'RIDER_AVAILABLE_BALANCE',   -- Liability: Delivery fees owed to moto riders
    'PLATFORM_REVENUE_FEE',      -- Equity/Revenue: 2.5% escrow service commission
    'GATEWAY_CLEARING_MOMO',     -- Asset: In-flight funds clearing via MTN Mobile Money
    'GATEWAY_CLEARING_ORANGE'    -- Asset: In-flight funds clearing via Orange Money
);

CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    account_type account_type NOT NULL,
    currency VARCHAR(3) DEFAULT 'XAF',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS journal_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reference_id UUID NOT NULL, -- references escrow_orders(id)
    description TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS postings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id),
    amount NUMERIC(14, 2) NOT NULL, -- Positive for DEBIT, Negative for CREDIT. Sum must balance to 0!
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Escrow Orders & FSM State Machine
CREATE TYPE escrow_status AS ENUM (
    'DRAFT',                       -- Initial order creation by seller
    'PENDING_PAYMENT',             -- Link active, waiting for MoMo/OM push approval
    'ESCROW_LOCKED',               -- Funds received from buyer, held safely in escrow pool
    'IN_TRANSIT',                  -- Seller handed package to rider; dispatch in progress
    'DELIVERED_PENDING_CONFIRM',   -- Rider arrived at buyer's doorstep, awaiting inspection
    'COMPLETED',                   -- 4-digit code verified; funds released to seller & rider
    'DISPUTED',                    -- Buyer rejected goods or flagged damage/counterfeit
    'REFUNDED_FULL',               -- Entire amount refunded to buyer (seller canceled/fault)
    'REFUNDED_PARTIAL',            -- Buyer refunded minus delivery fee paid to rider
    'EXPIRED'                      -- Payment link expired without payment
);

CREATE TYPE payment_network AS ENUM ('MTN_MOMO', 'ORANGE_MONEY');

CREATE TABLE IF NOT EXISTS escrow_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_code VARCHAR(12) UNIQUE NOT NULL, -- Public reference, e.g., 'CM-ESC-83921'
    seller_id UUID NOT NULL REFERENCES users(id),
    buyer_id UUID REFERENCES users(id), -- Populated upon click or phone match
    rider_id UUID REFERENCES users(id), -- Assigned moto rider
    
    item_title VARCHAR(255) NOT NULL,
    item_description TEXT,
    item_price NUMERIC(12, 2) NOT NULL, -- in FCFA (XAF)
    delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0.00, -- in FCFA
    platform_fee NUMERIC(12, 2) NOT NULL DEFAULT 0.00, -- 2.5%
    total_amount NUMERIC(12, 2) NOT NULL, -- item_price + delivery_fee + (optional buyer share fee)
    
    status escrow_status NOT NULL DEFAULT 'DRAFT',
    payment_network payment_network,
    payment_reference VARCHAR(100), -- Aggregator transaction ID (Campay/Notch Pay)
    
    -- Security: 4-Digit Release Code (Hashed with salt)
    release_code_hash VARCHAR(255),
    verification_attempts INT DEFAULT 0,
    max_verification_attempts INT DEFAULT 3,
    
    delivery_address TEXT,
    buyer_phone VARCHAR(20),
    seller_phone VARCHAR(20),
    rider_phone VARCHAR(20),
    
    dispute_reason TEXT,
    dispute_evidence_urls TEXT[],
    
    payment_confirmed_at TIMESTAMP WITH TIME ZONE,
    dispatched_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexing for high-speed bot query performance
CREATE INDEX IF NOT EXISTS idx_orders_code ON escrow_orders(order_code);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON escrow_orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON escrow_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_rider ON escrow_orders(rider_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON escrow_orders(status);
