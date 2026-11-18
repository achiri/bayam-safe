-- Unified PostgreSQL + PostGIS Schema: BayamSafe
-- Merging Digital Escrow & Trust Layer + Micro-Logistics & Inter-City Travel Agency Network

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- 1. Users Table
CREATE TYPE user_role AS ENUM ('MERCHANT', 'BUYER', 'RIDER', 'ADMIN');

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id BIGINT UNIQUE,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    role user_role NOT NULL DEFAULT 'BUYER',
    full_name VARCHAR(120) NOT NULL,
    preferred_language VARCHAR(5) DEFAULT 'fr',
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Rider Profile & Collateral Float Ledger
CREATE TYPE vehicle_type AS ENUM ('MOTO', 'CAR', 'VAN');

CREATE TABLE IF NOT EXISTS rider_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    cni_number VARCHAR(50) UNIQUE NOT NULL,
    cni_photo_url TEXT,
    vehicle_type vehicle_type DEFAULT 'MOTO',
    wallet_balance NUMERIC(12, 2) DEFAULT 0.00, -- In-app collateral float for COD acceptance
    is_active BOOLEAN DEFAULT FALSE,           -- /on_duty vs /off_duty
    current_location GEOMETRY(Point, 4326),
    trust_score NUMERIC(3, 2) DEFAULT 5.00,
    rating_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Travel Agencies Directory (Cameroon Inter-City Bus Terminals)
CREATE TABLE IF NOT EXISTS travel_agencies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,            -- e.g. 'Moghamo Express', 'Guarantee Express', 'Buca Voyages'
    city VARCHAR(50) NOT NULL,             -- 'Douala', 'Yaoundé', 'Bamenda', 'Buea', 'Bafoussam'
    terminal_name VARCHAR(100) NOT NULL,   -- e.g. 'Bonaberi Terminal', 'Mvan Agency', 'Mile 4 Station'
    contact_phone VARCHAR(20),
    geom GEOMETRY(Point, 4326) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Double-Entry Accounting Ledger (COBAC Compliant)
CREATE TYPE account_type AS ENUM (
    'ESCROW_HOLDING_POOL',      -- Digital payments locked on behalf of buyers
    'MERCHANT_WALLET',          -- Funds owed to sellers after delivery
    'RIDER_WALLET_FLOAT',       -- Float held by moto riders for COD collateral & delivery fees
    'AGENCY_TRANSIT_POOL',      -- Inter-city travel agency fees
    'PLATFORM_REVENUE_FEE',     -- Platform commission
    'GATEWAY_CLEARING_MOMO',    -- MTN Mobile Money clearing
    'GATEWAY_CLEARING_ORANGE'   -- Orange Money clearing
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
    reference_id UUID NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS postings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id),
    amount NUMERIC(14, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Unified Orders State Machine (Intra-City & Inter-City Agency Concierge)
CREATE TYPE order_type AS ENUM ('INTRA_CITY', 'INTER_CITY_AGENCY');

CREATE TYPE order_status AS ENUM (
    'DRAFT',
    'SEARCHING_RIDER',            -- Searching nearest moto rider via Redis GeoSearch
    'ASSIGNED',                   -- Rider accepted gig with mutex lock
    'AT_PICKUP',                  -- Rider at merchant location
    'IN_TRANSIT',                 -- Item in transit with first-mile rider
    'AGENCY_DROPPED',             -- Handed to travel agency bus (Waybill uploaded)
    'DESTINATION_HUB',            -- Bus arrived at destination city hub
    'LAST_MILE_ASSIGNED',         -- Destination rider assigned to pick up from agency
    'LAST_MILE_TRANSIT',          -- Final delivery leg in progress
    'DELIVERED',                  -- 4-digit OTP verified + PoD photo captured
    'SETTLED',                    -- Automated MoMo/OM disbursement executed
    'DISPUTED',                   -- Return initiated
    'CANCELLED',
    'EXPIRED'
);

CREATE TYPE payment_mode AS ENUM ('DIGITAL_ESCROW', 'CASH_ON_DELIVERY');
CREATE TYPE payment_network AS ENUM ('MTN_MOMO', 'ORANGE_MONEY');

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tracking_code VARCHAR(16) UNIQUE NOT NULL, -- e.g. 'BS-DLA-83921'
    order_type order_type NOT NULL DEFAULT 'INTRA_CITY',
    
    merchant_id UUID NOT NULL REFERENCES users(id),
    recipient_phone VARCHAR(20) NOT NULL,
    recipient_name VARCHAR(100),
    first_mile_rider_id UUID REFERENCES users(id),
    last_mile_rider_id UUID REFERENCES users(id),
    agency_id UUID REFERENCES travel_agencies(id),

    -- Informal Cameroon Waypoints & Voice Guidance
    pickup_address TEXT NOT NULL,
    pickup_geom GEOMETRY(Point, 4326),
    dropoff_address TEXT NOT NULL,
    dropoff_geom GEOMETRY(Point, 4326),
    landmark_notes TEXT,
    voice_note_url TEXT,

    -- Financials (in XAF / FCFA)
    item_title VARCHAR(255) NOT NULL,
    item_price NUMERIC(12, 2) NOT NULL,
    delivery_fee NUMERIC(10, 2) NOT NULL,
    agency_fee NUMERIC(10, 2) DEFAULT 0.00,
    platform_commission NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    cod_amount NUMERIC(12, 2) DEFAULT 0.00,
    payment_mode payment_mode NOT NULL DEFAULT 'DIGITAL_ESCROW',
    payment_network payment_network,
    payment_reference VARCHAR(100),

    -- Verification & Proof of Delivery
    delivery_otp_hash VARCHAR(255) NOT NULL,
    verification_attempts INT DEFAULT 0,
    pod_photo_url TEXT,
    agency_waybill_url TEXT,
    agency_waybill_number VARCHAR(50),

    status order_status NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Geospatial & Query Indexes
CREATE INDEX IF NOT EXISTS idx_orders_pickup_geom ON orders USING GIST (pickup_geom);
CREATE INDEX IF NOT EXISTS idx_orders_dropoff_geom ON orders USING GIST (dropoff_geom);
CREATE INDEX IF NOT EXISTS idx_agencies_geom ON travel_agencies USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_riders_geom ON rider_profiles USING GIST (current_location);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_tracking ON orders(tracking_code);

-- Seed Cameroonian Inter-City Travel Agencies
INSERT INTO travel_agencies (name, city, terminal_name, contact_phone, geom)
VALUES 
    ('Moghamo Express', 'Douala', 'Bonaberi Terminal', '237677000101', ST_SetSRID(ST_MakePoint(9.6644, 4.0763), 4326)),
    ('Moghamo Express', 'Bamenda', 'Mile 4 Station', '237677000102', ST_SetSRID(ST_MakePoint(10.1512, 5.9597), 4326)),
    ('Guarantee Express', 'Yaoundé', 'Mvan Agency Terminal', '237677000103', ST_SetSRID(ST_MakePoint(11.5167, 3.8242), 4326)),
    ('Guarantee Express', 'Douala', 'Bassa Ndokoti Agency', '237677000104', ST_SetSRID(ST_MakePoint(9.7360, 4.0483), 4326)),
    ('Buca Voyages', 'Douala', 'Mboppi Gare', '237677000105', ST_SetSRID(ST_MakePoint(9.7121, 4.0531), 4326)),
    ('Buca Voyages', 'Yaoundé', 'Mvan Station', '237677000106', ST_SetSRID(ST_MakePoint(11.5180, 3.8250), 4326)),
    ('Touristique Express', 'Yaoundé', 'Nsam Agency', '237677000107', ST_SetSRID(ST_MakePoint(11.5074, 3.8340), 4326))
ON CONFLICT DO NOTHING;
