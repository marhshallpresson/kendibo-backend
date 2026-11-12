-- 051_catalog_categories.sql
-- Full service catalogue from the landing page (7 trade groups, 58 trades),
-- a product shelf (8 product categories), and the columns provider-made
-- categories need (is_new, added_by_provider). Additive only.
--
-- The 8 original ids (cleaning, ac, plumbing, electrical, generator, handyman,
-- appliance, pest) are kept and mapped onto their landing-page trade, so
-- existing bookings, offerings, enrollments and skills keep working.
-- short_name is what chat surfaces show (WhatsApp list rows allow 24 chars).
-- New ids must not equal a skill tag (catalog.service.requires_skill, e.g.
-- 'hvac' = AC technicians), so Central HVAC is 'central-hvac'.
-- Applied by scripts/migrate.ts (prod) and packages/database/local.ts (pg-mem).

CREATE TABLE IF NOT EXISTS catalog.category_group (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  icon_name TEXT,
  kind TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('service', 'product'))
);

ALTER TABLE catalog.category ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'service';
ALTER TABLE catalog.category ADD COLUMN IF NOT EXISTS keywords TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE catalog.category ADD COLUMN IF NOT EXISTS is_new BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE catalog.category ADD COLUMN IF NOT EXISTS added_by_provider UUID;
ALTER TABLE catalog.category ADD COLUMN IF NOT EXISTS group_id TEXT;
ALTER TABLE catalog.category ADD COLUMN IF NOT EXISTS short_name TEXT;
CREATE INDEX IF NOT EXISTS idx_category_group_sort ON catalog.category (group_id, sort_order);

INSERT INTO catalog.category_group (id, name, short_name, sort_order, icon_name, kind) VALUES
 ('cleaning-pest', 'Cleaning, Housekeeping & Pest Control', 'Cleaning & Pest Control', 1, 'Sparkles', 'service'),
 ('electrical-power', 'Electrical, Solar, Inverter & Power Systems', 'Electrical & Solar', 2, 'Zap', 'service'),
 ('plumbing-water', 'Plumbing, Water Treatment & Borehole', 'Plumbing & Borehole', 3, 'Droplets', 'service'),
 ('ac-appliances', 'AC, Refrigeration & Home Appliances', 'AC & Appliances', 4, 'Snowflake', 'service'),
 ('carpentry-interior', 'Carpentry, Furniture, POP & Interior Finishing', 'Carpentry & Interiors', 5, 'Hammer', 'service'),
 ('building-outdoor', 'Building, Masonry, Roofing, Welding & Outdoor', 'Building & Outdoor', 6, 'HardHat', 'service'),
 ('smart-security-domestic', 'Smart Home, Security, Relocation & Domestic Support', 'Security & Home Support', 7, 'ShieldCheck', 'service'),
 ('home-products', 'Home Products & Supplies', 'Home Products', 8, 'ShoppingBag', 'product'),
 ('other', 'Other Services', 'Other Services', 99, 'Wrench', 'service')
ON CONFLICT (id) DO NOTHING;

-- ── The original 8: same ids, landing-page names, placed in their group ─────
UPDATE catalog.category SET name = 'Standard Home & Apartment Cleaning', short_name = 'Home Cleaning', group_id = 'cleaning-pest', sort_order = 101, kind = 'service',
  keywords = ARRAY['cleaning', 'cleaner', 'house cleaning', 'home cleaning', 'apartment cleaning', 'flat cleaning', 'sweep', 'mop', 'clean my house', 'clean my room']
  WHERE id = 'cleaning';
UPDATE catalog.category SET name = 'Fumigation, Pest Control, Termite & Rodent Treatment', short_name = 'Pest Control', group_id = 'cleaning-pest', sort_order = 109, kind = 'service',
  keywords = ARRAY['fumigation', 'fumigate', 'pest control', 'pest', 'termite', 'termites', 'rodent', 'rat', 'rats', 'cockroach', 'cockroaches', 'bed bugs', 'bedbugs', 'exterminator', 'snake', 'ants']
  WHERE id = 'pest';
UPDATE catalog.category SET name = 'Domestic & Commercial Electrical Wiring & Troubleshooting', short_name = 'Electrical', group_id = 'electrical-power', sort_order = 201, kind = 'service',
  keywords = ARRAY['electrician', 'electrical', 'wiring', 'rewiring', 'socket', 'switch', 'short circuit', 'no light', 'nepa', 'phcn', 'light problem', 'spark']
  WHERE id = 'electrical';
UPDATE catalog.category SET name = 'Generator Servicing & Repairs (Petrol & Diesel)', short_name = 'Generator', group_id = 'electrical-power', sort_order = 203, kind = 'service',
  keywords = ARRAY['generator', 'gen', 'genset', 'generator repair', 'diesel generator', 'petrol generator', 'gen mechanic', 'carburetor', 'carburettor']
  WHERE id = 'generator';
UPDATE catalog.category SET name = 'General Plumbing, Pipe Leak & Blocked Drain Repairs', short_name = 'Plumbing', group_id = 'plumbing-water', sort_order = 301, kind = 'service',
  keywords = ARRAY['plumber', 'plumbing', 'pipe', 'pipe leak', 'burst pipe', 'blocked drain', 'blocked toilet', 'leaking tap', 'tap', 'drain', 'toilet', 'sink', 'leak']
  WHERE id = 'plumbing';
UPDATE catalog.category SET name = 'Air Conditioning Installation, Gas Refill & Servicing (Split / Standing / Cassette)', short_name = 'AC Services', group_id = 'ac-appliances', sort_order = 401, kind = 'service',
  keywords = ARRAY['ac', 'a/c', 'air conditioner', 'air conditioning', 'aircon', 'ac gas', 'gas refill', 'split unit', 'standing unit', 'cassette', 'ac servicing', 'ac not cooling', 'ac repair']
  WHERE id = 'ac';
UPDATE catalog.category SET name = 'Refrigerator, Deep Freezer & Cold Room Repairs', short_name = 'Fridge & Freezer', group_id = 'ac-appliances', sort_order = 403, kind = 'service',
  keywords = ARRAY['fridge', 'refrigerator', 'freezer', 'deep freezer', 'frezzer', 'cold room', 'fridge not cooling', 'appliance', 'appliances']
  WHERE id = 'appliance';
UPDATE catalog.category SET name = 'General Handyman & Multi-Trade Home Repairs', short_name = 'Handyman', group_id = 'building-outdoor', sort_order = 608, kind = 'service',
  keywords = ARRAY['handyman', 'odd jobs', 'minor repairs', 'furniture assembly', 'assemble furniture', 'mounting', 'hang picture', 'shelf']
  WHERE id = 'handyman';

-- ── The other 50 landing-page trades ────────────────────────────────────────
INSERT INTO catalog.category (id, name, short_name, active, sort_order, icon_name, group_id, kind, keywords, created_via) VALUES
 ('deep-cleaning', 'Deep Cleaning & Move-In / Move-Out Cleaning', 'Deep Cleaning', TRUE, 102, 'SprayCan', 'cleaning-pest', 'service', ARRAY['deep clean', 'deep cleaning', 'move in cleaning', 'move out cleaning', 'moving out', 'end of tenancy'], 'seed'),
 ('post-construction-cleaning', 'Post-Construction & Renovation Cleaning', 'Post-Build Cleaning', TRUE, 103, 'Construction', 'cleaning-pest', 'service', ARRAY['post construction', 'after construction', 'renovation cleaning', 'after renovation', 'builders clean', 'construction cleaning'], 'seed'),
 ('office-cleaning', 'Office, Commercial & Facility Cleaning', 'Office Cleaning', TRUE, 104, 'Building2', 'cleaning-pest', 'service', ARRAY['office cleaning', 'commercial cleaning', 'janitor', 'janitorial', 'shop cleaning', 'church cleaning'], 'seed'),
 ('upholstery-cleaning', 'Carpet, Rug, Sofa & Upholstery Cleaning', 'Carpet & Sofa Cleaning', TRUE, 105, 'Sofa', 'cleaning-pest', 'service', ARRAY['carpet cleaning', 'carpet', 'rug', 'rug cleaning', 'sofa cleaning', 'couch cleaning', 'upholstery cleaning', 'wash my rug', 'wash rug', 'wash carpet', 'wash my carpet', 'wash my sofa', 'wash sofa'], 'seed'),
 ('mattress-sanitisation', 'Mattress Steam Sanitisation & Odour Removal', 'Mattress Cleaning', TRUE, 106, 'BedDouble', 'cleaning-pest', 'service', ARRAY['mattress', 'mattress cleaning', 'steam clean', 'odour removal', 'odor removal', 'bad smell'], 'seed'),
 ('window-cleaning', 'Window, Glass & High-Facade Cleaning', 'Window Cleaning', TRUE, 107, 'Building', 'cleaning-pest', 'service', ARRAY['window cleaning', 'glass cleaning', 'facade cleaning', 'facade', 'high rise windows', 'clean windows', 'clean my windows'], 'seed'),
 ('laundry', 'Laundry, Dry Cleaning, Ironing & Wardrobe Care', 'Laundry & Ironing', TRUE, 108, 'Shirt', 'cleaning-pest', 'service', ARRAY['laundry', 'dry clean', 'dry cleaning', 'dry cleaner', 'ironing', 'iron my clothes', 'washman', 'wash clothes', 'wash my clothes'], 'seed'),
 ('pool-cleaning', 'Swimming Pool Cleaning & Chemical Balancing', 'Pool Cleaning', TRUE, 110, 'Waves', 'cleaning-pest', 'service', ARRAY['swimming pool', 'pool cleaning', 'pool chemical', 'pool water', 'pool'], 'seed'),
 ('septic-evacuation', 'Septic Tank, Soakaway & Sewage Evacuation', 'Septic & Soakaway', TRUE, 111, 'Truck', 'cleaning-pest', 'service', ARRAY['septic tank', 'septic', 'soakaway', 'soak away', 'sewage', 'suck away', 'evacuate soakaway', 'soakaway full', 'toilet pit', 'sewage truck'], 'seed'),
 ('water-tank-cleaning', 'Overhead Water Tank & Sump Cleaning', 'Water Tank Cleaning', TRUE, 112, 'Container', 'cleaning-pest', 'service', ARRAY['water tank', 'tank cleaning', 'overhead tank', 'sump', 'geepee tank', 'gp tank', 'wash tank'], 'seed'),

 ('solar-inverter', 'Solar Panel, Inverter & Lithium Battery Installation / Repair', 'Solar & Inverter', TRUE, 202, 'Sun', 'electrical-power', 'service', ARRAY['solar', 'solar panel', 'solar panels', 'inverter', 'lithium battery', 'inverter battery', 'solar installation', 'solar battery', 'charge controller'], 'seed'),
 ('ats-changeover', 'Automatic Transfer Switch (ATS) & Changeover Installation', 'ATS & Changeover', TRUE, 204, 'ToggleRight', 'electrical-power', 'service', ARRAY['ats', 'changeover', 'change over', 'automatic transfer switch', 'change-over'], 'seed'),
 ('lighting-fittings', 'Lighting, Chandelier, POP Spotlight & Ceiling Fan Fitting', 'Lighting & Fans', TRUE, 205, 'Lightbulb', 'electrical-power', 'service', ARRAY['chandelier', 'spotlight', 'pop light', 'pop lights', 'ceiling fan', 'light fitting', 'downlight', 'bulb fitting', 'led strip'], 'seed'),
 ('db-earthing', 'Distribution Board (DB), Breaker & Earthing Protection', 'DB & Earthing', TRUE, 206, 'CircuitBoard', 'electrical-power', 'service', ARRAY['distribution board', 'breaker', 'circuit breaker', 'earthing', 'surge protector', 'db box', 'breaker box'], 'seed'),
 ('prepaid-meter', 'Prepaid Meter & Sub-Meter Wiring Support', 'Prepaid Meter', TRUE, 207, 'Gauge', 'electrical-power', 'service', ARRAY['prepaid meter', 'sub meter', 'submeter', 'sub-meter', 'meter wiring', 'meter installation', 'token meter'], 'seed'),

 ('water-heater-pump', 'Water Heater, Pumping Machine & Pressure Booster Servicing', 'Heater & Pump', TRUE, 302, 'Thermometer', 'plumbing-water', 'service', ARRAY['water heater', 'heater', 'pumping machine', 'water pump', 'booster pump', 'pressure pump', 'surface pump', 'pressure booster'], 'seed'),
 ('borehole', 'Borehole Drilling, Flushing & Submersible Pump Repair', 'Borehole', TRUE, 303, 'Drill', 'plumbing-water', 'service', ARRAY['borehole', 'bore hole', 'submersible pump', 'submersible', 'borehole pump', 'borehole flushing', 'drill borehole'], 'seed'),
 ('water-treatment', 'Water Treatment Plant & Filtration System Maintenance', 'Water Treatment', TRUE, 304, 'Filter', 'plumbing-water', 'service', ARRAY['water treatment', 'water filter', 'filtration', 'treatment plant', 'water softener', 'iron in water', 'brown water', 'dirty water'], 'seed'),
 ('bathroom-fitting', 'Bathroom, WC, Jacuzzi, Shower Cubicle & Kitchen Sink Fitting', 'Bathroom Fitting', TRUE, 305, 'Bath', 'plumbing-water', 'service', ARRAY['jacuzzi', 'shower cubicle', 'wc fitting', 'bathroom fitting', 'sink installation', 'kitchen sink', 'water closet', 'bath tub', 'bathtub', 'install toilet'], 'seed'),
 ('gas-piping', 'Gas Piping & Leak Detection', 'Gas Piping', TRUE, 306, 'Flame', 'plumbing-water', 'service', ARRAY['gas pipe', 'gas piping', 'gas leak', 'smell gas', 'lpg', 'gas line', 'cooking gas pipe'], 'seed'),

 ('central-hvac', 'Central HVAC & Commercial Ducted Cooling Systems', 'Central HVAC', TRUE, 402, 'AirVent', 'ac-appliances', 'service', ARRAY['hvac', 'central air', 'ducted', 'chiller', 'vrf', 'ducting', 'central cooling'], 'seed'),
 ('laundry-appliance-repair', 'Washing Machine, Tumble Dryer & Dishwasher Repairs', 'Washer & Dryer', TRUE, 404, 'WashingMachine', 'ac-appliances', 'service', ARRAY['washing machine', 'washer', 'tumble dryer', 'dryer', 'dishwasher'], 'seed'),
 ('kitchen-appliance-repair', 'Gas Cooker, Electric Oven, Microwave & Kitchen Extractor Hood Repairs', 'Cooker & Oven', TRUE, 405, 'CookingPot', 'ac-appliances', 'service', ARRAY['gas cooker', 'cooker', 'oven', 'microwave', 'extractor', 'cooker hood', 'burner', 'electric cooker'], 'seed'),
 ('small-appliance-repair', 'Water Dispenser, Blender & Small Appliance Repairs', 'Small Appliances', TRUE, 406, 'Plug', 'ac-appliances', 'service', ARRAY['water dispenser', 'dispenser', 'blender', 'small appliance', 'toaster', 'kettle', 'pressing iron', 'standing fan'], 'seed'),

 ('carpentry', 'Carpentry, Wooden Door, Smart Lock & Window Repairs', 'Carpentry & Doors', TRUE, 501, 'DoorOpen', 'carpentry-interior', 'service', ARRAY['carpenter', 'carpentry', 'wooden door', 'door repair', 'door lock', 'window repair', 'hinge', 'door'], 'seed'),
 ('custom-furniture', 'Custom Furniture, Wardrobe, TV Console & Kitchen Cabinetry', 'Custom Furniture', TRUE, 502, 'Armchair', 'carpentry-interior', 'service', ARRAY['wardrobe', 'tv console', 'kitchen cabinet', 'kitchen cabinets', 'cabinetry', 'custom furniture', 'built-in wardrobe', 'furniture maker'], 'seed'),
 ('upholstery', 'Upholstery Re-covering & Sofa Frame Restoration', 'Upholstery', TRUE, 503, 'Sofa', 'carpentry-interior', 'service', ARRAY['upholstery', 'upholsterer', 're-cover sofa', 'recover sofa', 'sofa repair', 'chair cover', 'recover chairs', 'sofa frame'], 'seed'),
 ('painting', 'Interior & Exterior Painting, Wall Screeding & Satin / Stucco Finish', 'Painting', TRUE, 504, 'Paintbrush', 'carpentry-interior', 'service', ARRAY['painter', 'painting', 'paint', 'screeding', 'screed', 'stucco', 'satin', 'wall paint', 'repaint'], 'seed'),
 ('wallpaper-panels', 'Wallpaper, 3D Wall Panel & Fluted Panel Installation', 'Wallpaper & Panels', TRUE, 505, 'Layers', 'carpentry-interior', 'service', ARRAY['wallpaper', '3d panel', '3d wall panel', 'wall panel', 'fluted panel', 'wpc panel'], 'seed'),
 ('pop-ceiling', 'POP Ceiling, Suspended Ceiling, Drywall & Partitioning', 'POP & Ceiling', TRUE, 506, 'LayoutPanelTop', 'carpentry-interior', 'service', ARRAY['pop', 'pop ceiling', 'suspended ceiling', 'drywall', 'partition', 'partitioning', 'ceiling board', 'plasterboard', 'pvc ceiling', 'ceiling'], 'seed'),
 ('tiling', 'Floor & Wall Tiling, Marble, Granite & Terrazzo Installation', 'Tiling & Marble', TRUE, 507, 'Grid3x3', 'carpentry-interior', 'service', ARRAY['tiles', 'tile', 'tiling', 'tiler', 'marble', 'granite', 'terrazzo', 'floor tiles', 'wall tiles'], 'seed'),
 ('flooring', 'Epoxy Flooring, Stamped Concrete & Wood Laminate Flooring', 'Epoxy & Flooring', TRUE, 508, 'SquareStack', 'carpentry-interior', 'service', ARRAY['epoxy', 'epoxy floor', 'stamped concrete', 'laminate', 'wood floor', 'vinyl floor', 'flooring', 'parquet'], 'seed'),
 ('aluminium-glass', 'Aluminium Windows, Casement Doors, Shower Glass & Balustrades', 'Aluminium & Glass', TRUE, 509, 'AppWindow', 'carpentry-interior', 'service', ARRAY['aluminium', 'aluminum', 'casement', 'sliding window', 'glass door', 'shower glass', 'balustrade', 'glass railing'], 'seed'),
 ('blinds-burglary', 'Curtain Rods, Window Blinds, Mosquito Nets & Burglary Proofing', 'Blinds & Burglary Proof', TRUE, 510, 'Blinds', 'carpentry-interior', 'service', ARRAY['curtain rod', 'curtain', 'curtains', 'blinds', 'window blinds', 'mosquito net', 'mosquito nets', 'burglary proof', 'burglar proof', 'window protector'], 'seed'),

 ('masonry', 'Masonry, Bricklaying, Plastering & Structural Concrete Repairs', 'Masonry', TRUE, 601, 'BrickWall', 'building-outdoor', 'service', ARRAY['mason', 'masonry', 'bricklayer', 'bricklaying', 'block work', 'blocks', 'plastering', 'plaster', 'concrete', 'crack in wall', 'cracked wall', 'fence wall'], 'seed'),
 ('roofing', 'Roofing Installation, Roof Leak Waterproofing & Rain Gutter Repairs', 'Roofing', TRUE, 602, 'Home', 'building-outdoor', 'service', ARRAY['roof', 'roofing', 'roofer', 'roof leak', 'leaking roof', 'gutter', 'waterproofing', 'roofing sheet', 'roofing sheets'], 'seed'),
 ('damp-proofing', 'Damp Proofing & Wall Seepage Treatment', 'Damp Proofing', TRUE, 603, 'Droplet', 'building-outdoor', 'service', ARRAY['damp', 'damp proofing', 'seepage', 'wall seepage', 'moisture', 'mould', 'mold', 'wet wall'], 'seed'),
 ('welding', 'Welding, Wrought Iron, Gate, Railings & Carport Fabrication', 'Welding & Gates', TRUE, 604, 'Flame', 'building-outdoor', 'service', ARRAY['welder', 'welding', 'wrought iron', 'iron gate', 'railing', 'railings', 'carport', 'fabrication', 'metal gate', 'gate'], 'seed'),
 ('gate-automation', 'Automated Gate Opener & Garage Door Installation', 'Gate Automation', TRUE, 605, 'DoorClosed', 'building-outdoor', 'service', ARRAY['automatic gate', 'gate opener', 'gate motor', 'sliding gate motor', 'garage door', 'remote gate', 'automated gate'], 'seed'),
 ('paving', 'Interlocking Paving Stones, Kerbs & Driveway Construction', 'Paving & Driveway', TRUE, 606, 'Grid2x2', 'building-outdoor', 'service', ARRAY['interlock', 'interlocking', 'paving stone', 'paving stones', 'paving', 'kerb', 'kerbs', 'curb', 'driveway'], 'seed'),
 ('landscaping', 'Landscaping, Lawn Care, Horticulture, Gardening & Tree Trimming', 'Landscaping & Garden', TRUE, 607, 'Trees', 'building-outdoor', 'service', ARRAY['landscaping', 'lawn', 'grass cutting', 'cut grass', 'gardener', 'gardening', 'garden', 'tree trimming', 'cut tree', 'horticulture', 'weed', 'flowers'], 'seed'),

 ('cctv', 'CCTV Camera, IP Surveillance & Remote Monitoring Installation', 'CCTV & Cameras', TRUE, 701, 'Cctv', 'smart-security-domestic', 'service', ARRAY['cctv', 'security camera', 'security cameras', 'surveillance', 'ip camera', 'camera installation', 'cameras'], 'seed'),
 ('electric-fence', 'Electric Fence, Razor Wire & Perimeter Intrusion Alarms', 'Electric Fence', TRUE, 702, 'Fence', 'smart-security-domestic', 'service', ARRAY['electric fence', 'razor wire', 'perimeter alarm', 'intrusion alarm', 'burglar alarm', 'fence wire', 'electric wire fence'], 'seed'),
 ('smart-home', 'Smart Door Locks, Video Doorbells & Home Automation', 'Smart Home', TRUE, 703, 'Smartphone', 'smart-security-domestic', 'service', ARRAY['smart lock', 'smart door lock', 'video doorbell', 'doorbell', 'home automation', 'smart home', 'smart switch'], 'seed'),
 ('tv-mounting', 'TV Wall Mounting, DSTV / Dish Alignment & Home Theatre Setup', 'TV & DSTV Setup', TRUE, 704, 'Tv', 'smart-security-domestic', 'service', ARRAY['tv mount', 'tv mounting', 'mount tv', 'mount my tv', 'hang tv', 'dstv', 'gotv', 'satellite dish', 'dish alignment', 'home theatre', 'home theater', 'decoder'], 'seed'),
 ('networking', 'Wi-Fi Mesh, Starlink Installation & Home Networking', 'Wi-Fi & Starlink', TRUE, 705, 'Wifi', 'smart-security-domestic', 'service', ARRAY['wifi', 'wi-fi', 'starlink', 'router', 'networking', 'internet installation', 'mesh wifi', 'network cable'], 'seed'),
 ('relocation', 'Home & Office Packing, Moving & Relocation Services', 'Moving & Relocation', TRUE, 706, 'Truck', 'smart-security-domestic', 'service', ARRAY['movers', 'relocation', 'relocate', 'packing and moving', 'move house', 'moving house', 'house moving', 'office move', 'moving truck'], 'seed'),
 ('private-chef', 'Private Chef, Home Catering & Event Kitchen Support', 'Private Chef', TRUE, 707, 'ChefHat', 'smart-security-domestic', 'service', ARRAY['chef', 'private chef', 'catering', 'caterer', 'home cook', 'event kitchen', 'small chops'], 'seed'),
 ('home-care', 'Housekeeper, Nanny & Elderly Home-Care Support', 'Nanny & Home-Care', TRUE, 708, 'HeartHandshake', 'smart-security-domestic', 'service', ARRAY['housekeeper', 'house help', 'nanny', 'babysitter', 'caregiver', 'elderly care', 'home care', 'maid'], 'seed'),
 ('facility-management', 'Full-Service Facility Management & Cleaning Agency', 'Facility Management', TRUE, 709, 'Building2', 'smart-security-domestic', 'service', ARRAY['facility management', 'facility manager', 'estate management', 'cleaning agency', 'property maintenance'], 'seed'),

 ('prod-cleaning-supplies', 'Cleaning Supplies & Detergents', 'Cleaning Supplies', TRUE, 801, 'SprayCan', 'home-products', 'product', ARRAY['detergent', 'bleach', 'cleaning supplies', 'disinfectant', 'soap'], 'seed'),
 ('prod-plumbing-materials', 'Plumbing Materials & Fittings', 'Plumbing Materials', TRUE, 802, 'Wrench', 'home-products', 'product', ARRAY['pvc pipe', 'pipes', 'fittings', 'plumbing materials', 'tap head'], 'seed'),
 ('prod-electrical-fittings', 'Electrical Fittings & Cables', 'Electrical Fittings', TRUE, 803, 'Cable', 'home-products', 'product', ARRAY['cable', 'cables', 'wire', 'sockets', 'switches', 'electrical fittings'], 'seed'),
 ('prod-solar-equipment', 'Solar & Inverter Equipment', 'Solar & Inverter Gear', TRUE, 804, 'BatteryCharging', 'home-products', 'product', ARRAY['solar panel', 'inverter', 'battery', 'lithium battery', 'charge controller'], 'seed'),
 ('prod-home-appliances', 'Home Appliances', 'Home Appliances', TRUE, 805, 'Refrigerator', 'home-products', 'product', ARRAY['fridge', 'freezer', 'washing machine', 'cooker', 'microwave', 'ac unit'], 'seed'),
 ('prod-paint-finishing', 'Paint & Finishing Materials', 'Paint & Finishing', TRUE, 806, 'PaintBucket', 'home-products', 'product', ARRAY['paint', 'emulsion', 'satin paint', 'putty', 'pop cement', 'screeding'], 'seed'),
 ('prod-security-devices', 'Security & CCTV Devices', 'Security Devices', TRUE, 807, 'ShieldCheck', 'home-products', 'product', ARRAY['cctv camera', 'dvr', 'nvr', 'smart lock', 'doorbell', 'alarm'], 'seed'),
 ('prod-water-treatment', 'Water Treatment Products', 'Water Treatment Products', TRUE, 808, 'GlassWater', 'home-products', 'product', ARRAY['water filter', 'filter cartridge', 'softener salt', 'chlorine', 'water treatment chemicals'], 'seed')
ON CONFLICT (id) DO NOTHING;

-- ── Rules for every new category: default commission 1500 bps ──────────────
INSERT INTO catalog.category_rule (category_id) VALUES
 ('deep-cleaning'), ('post-construction-cleaning'), ('office-cleaning'), ('upholstery-cleaning'), ('mattress-sanitisation'),
 ('window-cleaning'), ('laundry'), ('pool-cleaning'), ('septic-evacuation'), ('water-tank-cleaning'),
 ('solar-inverter'), ('ats-changeover'), ('lighting-fittings'), ('db-earthing'), ('prepaid-meter'),
 ('water-heater-pump'), ('borehole'), ('water-treatment'), ('bathroom-fitting'), ('gas-piping'),
 ('central-hvac'), ('laundry-appliance-repair'), ('kitchen-appliance-repair'), ('small-appliance-repair'),
 ('carpentry'), ('custom-furniture'), ('upholstery'), ('painting'), ('wallpaper-panels'), ('pop-ceiling'),
 ('tiling'), ('flooring'), ('aluminium-glass'), ('blinds-burglary'),
 ('masonry'), ('roofing'), ('damp-proofing'), ('welding'), ('gate-automation'), ('paving'), ('landscaping'),
 ('cctv'), ('electric-fence'), ('smart-home'), ('tv-mounting'), ('networking'), ('relocation'), ('private-chef'),
 ('home-care'), ('facility-management'),
 ('prod-cleaning-supplies'), ('prod-plumbing-materials'), ('prod-electrical-fittings'), ('prod-solar-equipment'),
 ('prod-home-appliances'), ('prod-paint-finishing'), ('prod-security-devices'), ('prod-water-treatment')
ON CONFLICT DO NOTHING;

-- Electrical-type work: same bar as 'electrical' (ID + face, tier 2, licence).
UPDATE catalog.category_rule
  SET min_kyc_tier = 2, licence_required = TRUE, licence_label = 'Electrical installation licence or COREN/NEMSA certificate',
      required_documents = '["licence"]'::jsonb
  WHERE category_id IN ('solar-inverter', 'ats-changeover', 'lighting-fittings', 'db-earthing', 'prepaid-meter', 'electric-fence', 'gate-automation');
-- Gas work: same bar as 'generator'.
UPDATE catalog.category_rule
  SET min_kyc_tier = 2, licence_required = TRUE, licence_label = 'Gas technician / LPG installation certificate',
      required_documents = '["licence"]'::jsonb
  WHERE category_id IN ('gas-piping');
-- Work at height, structural or heavy plant: tier 2 and insurance on file.
UPDATE catalog.category_rule
  SET min_kyc_tier = 2, insurance_required = TRUE, required_documents = '["insurance"]'::jsonb
  WHERE category_id IN ('roofing', 'masonry', 'welding', 'borehole', 'central-hvac');
-- In-home care and agencies: tier 2; agencies show a CAC registration.
UPDATE catalog.category_rule SET min_kyc_tier = 2 WHERE category_id IN ('home-care', 'private-chef', 'septic-evacuation');
UPDATE catalog.category_rule SET require_cac = TRUE WHERE category_id IN ('facility-management');
