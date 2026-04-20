# Freeze & Edit Persistence and BOM Editable Rate Fix

## Overview
Fixed two related issues:
1. **Manage Product UI**: Freeze & Edit checkboxes becoming unchecked after refresh
2. **Generate BOM**: Only materials marked "freeze and edit" in approved products should have editable rate fields

## Root Cause
The `freeze_and_edit` flag was sent by the client but **not persisted** in the database during the approval workflow. This caused:
- The flag to be lost after refresh in manage product
- The flag to not propagate to the generated BOM, so all items appeared non-editable

## Changes Made

### 1. Database Schema Migrations

#### `create_approval_tables.ts`
- Added `freeze_and_edit BOOLEAN DEFAULT FALSE` column to `product_approval_items` table definition

#### `server/routes.ts`
- **Table Initialization** (lines 1034-1097):
  - Added `freeze_and_edit BOOLEAN DEFAULT FALSE` to initial `product_step3_config_items` CREATE statement
  - Added `freeze_and_edit BOOLEAN DEFAULT FALSE` to initial `step11_product_items` CREATE statement
  - Added ALTER statements to ensure `freeze_and_edit` column exists on both tables

- **Column Ensurance** (line 7495):
  - Added `ALTER TABLE product_approval_items ADD COLUMN IF NOT EXISTS freeze_and_edit BOOLEAN DEFAULT FALSE`

### 2. Server Route Updates

#### POST `/api/product-approvals` (Submit for Approval)
- **Line 7535-7548**: Updated `INSERT INTO product_approval_items` to include 15 parameters
  - Added `freeze_and_edit` parameter
  - Populates with: `item.freezeAndEdit === true || item.freeze_and_edit === true`

#### PUT `/api/product-approvals/:id` (Update Approval)
- **Line 7658-7671**: Updated `INSERT INTO product_approval_items` to include 15 parameters
  - Added `freeze_and_edit` parameter with same logic

#### POST `/api/product-approvals/:id/approve` (Approve & Persist)
- **product_step3_config_items persistence** (lines 7728-7745):
  - Added `ALTER TABLE product_step3_config_items ADD COLUMN IF NOT EXISTS freeze_and_edit BOOLEAN DEFAULT FALSE`
  - Updated INSERT to 15 columns including `freeze_and_edit`
  - Reads from approval items: `item.freeze_and_edit === true || item.freezeAndEdit === true`

- **step11_product_items persistence** (lines 7776-7787):
  - Added `ALTER TABLE step11_product_items ADD COLUMN IF NOT EXISTS freeze_and_edit BOOLEAN DEFAULT FALSE`
  - Updated INSERT to include `freeze_and_edit` column
  - Reads from approval items with same logic

#### POST `/api/step11-products` (Direct Save - Step 11 Items)
- **Lines 6989-7006**: Updated INSERT to include `freeze_and_edit`
  - Checks: `item.freezeAndEdit === true || item.freeze_and_edit === true`

#### POST `/api/product-step3-config` (Direct Save - Step 3 Config)
- **Lines 7117-7148**: Updated INSERT to include `freeze_and_edit`
  - Reads from payload items: `item.freezeAndEdit === true || item.freeze_and_edit === true`

### 3. Client-Side BOM Rendering

#### `client/src/pages/CreateBoq.tsx`

**Engine-Computed Items** (lines 342-358):
- Updated the `computedLines` mapping to include `freezeAndEdit` preservation:
  ```typescript
  freezeAndEdit: line.freezeAndEdit === true || line.freeze_and_edit === true,
  ```

**Rate Cell Rendering** (lines 875-905):
- Changed rate display cell from read-only to **conditionally editable**:
  - **If freezeAndEdit === true**: Renders an `<Input />` field for rate editing
  - **Otherwise**: Renders read-only ₹ text display
  
- Input field includes:
  - onChange handler to parse and update rate, supply_rate, install_rate
  - onBlur handler to persist changes
  - Disabled when `isVersionSubmitted`

## Workflow

### Freeze & Edit Checkbox Persistence
1. User checks "Freeze & Edit" box in Manage Product
2. Checkbox state stored in React state as `freezeAndEdit: boolean`
3. On submit, payload includes `freeze_and_edit: m.freezeAndEdit`
4. **NEW**: Server persists `freeze_and_edit` to `product_approval_items`
5. **NEW**: On approval, `freeze_and_edit` copied to `product_step3_config_items` and `step11_product_items`
6. On page refresh, checkbox reloads from DB with correct state ✓

### Generate BOM Editable Rate Control
1. After approval, user adds product to BOM
2. Client loads `step11_product_items` which now includes `freeze_and_edit` flag
3. **NEW**: On BOM render, inspects `freezeAndEdit` flag:
   - If TRUE: Rate cell is an editable input
   - If FALSE: Rate cell is read-only display
4. Only materials marked freeze+edit can have rates edited in BOM ✓

## Testing Checklist
- [ ] Manage Product: Check freeze/edit, save, refresh → checkbox remains checked
- [ ] Manage Product: Uncheck freeze/edit, save, refresh → checkbox remains unchecked
- [ ] Generate BOM: Load product with mixed freeze/edit items
  - [ ] Freeze+edit items show editable rate inputs
  - [ ] Non-freeze items show read-only rate display
- [ ] Edit rate for freeze+edit item, save project
  - [ ] Rate persists after refresh
  - [ ] Amount recalculates with new rate
