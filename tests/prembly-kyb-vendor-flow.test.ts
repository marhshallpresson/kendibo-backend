import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNameAlignment, kycService } from '../modules/kyc/kyc.service.js';
import { providerService } from '../modules/providers/provider.service.js';

test('Prembly Name Alignment Engine links Legal Name, CAC Business Name, and Bank Account Holder', () => {
  const alignedPersonal = verifyNameAlignment({
    submittedName: 'Chukwuemeka Adaeze Okafor',
    businessName: 'Apex Cool HVAC Services Ltd',
    ninLegalName: 'CHUKWUEMEKA ADAEZE OKAFOR',
    bvnLegalName: 'OKAFOR CHUKWUEMEKA ADAEZE',
    cacCompanyName: 'APEX COOL HVAC SERVICES LIMITED',
    bankAccountName: 'OKAFOR CHUKWUEMEKA A.',
  });
  assert.equal(alignedPersonal.aligned, true);
  assert.equal(alignedPersonal.personalAligned, true);
  assert.equal(alignedPersonal.cacAligned, true);
  assert.equal(alignedPersonal.bankAligned, true);
  assert.ok(alignedPersonal.score >= 85);

  const alignedCorporateBank = verifyNameAlignment({
    submittedName: 'Chukwuemeka Adaeze Okafor',
    businessName: 'Apex Cool HVAC Services Ltd',
    ninLegalName: 'CHUKWUEMEKA ADAEZE OKAFOR',
    cacCompanyName: 'APEX COOL HVAC SERVICES LTD',
    bankAccountName: 'APEX COOL HVAC SERVICES LIMITED',
  });
  assert.equal(alignedCorporateBank.aligned, true);
  assert.equal(alignedCorporateBank.bankAligned, true);

  const mismatchedBank = verifyNameAlignment({
    submittedName: 'Chukwuemeka Adaeze Okafor',
    businessName: 'Apex Cool HVAC Services Ltd',
    ninLegalName: 'CHUKWUEMEKA ADAEZE OKAFOR',
    cacCompanyName: 'APEX COOL HVAC SERVICES LTD',
    bankAccountName: 'COMPLETELY UNRELATED PERSON',
  });
  assert.equal(mismatchedBank.aligned, false);
  assert.equal(mismatchedBank.bankAligned, false);
  assert.ok(mismatchedBank.mismatchReason?.includes('Bank account name'));
});

test('Prembly MCP Server manifest exposes Nigeria KYC, CAC KYB, Face Biometrics, and Bank tools', async () => {
  const tools = kycService.listMcpTools();
  assert.ok(tools.length >= 6);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('prembly_verify_nin'));
  assert.ok(names.includes('prembly_verify_bvn'));
  assert.ok(names.includes('prembly_verify_cac'));
  assert.ok(names.includes('prembly_verify_face_liveness'));
  assert.ok(names.includes('prembly_verify_bank_account'));
  assert.ok(names.includes('prembly_check_name_alignment'));

  const cacRes = (await kycService.executeMcpTool('prembly_verify_cac', {
    rcNumber: 'RC1234567',
    companyName: 'Apex Cool Services Ltd',
  })) as { verified: boolean; companyName?: string };
  assert.equal(cacRes.verified, true);
  assert.ok(cacRes.companyName);
});

test('Vendor Storefront, Office Map Pinpoint, Service Packages & Dispatch Feed operate cleanly without AI labels', async () => {
  const uid = `usr_vendor_${Date.now()}`;
  const prov = await providerService.onboard(uid);
  assert.ok(prov.id);

  const updated = await providerService.updateStorefront(prov.id, {
    businessName: 'Apex Cool Engineering Ltd',
    headline: 'Certified HVAC & Electrical Specialists',
    bio: 'CAC-verified engineering team with 24/7 response.',
    officeAddress: '14 Admiralty Way, Lekki Phase 1',
    officeStreet: '14 Admiralty Way',
    officeLandmark: 'Opposite Total Station',
    officeCity: 'Lagos',
    lat: 6.4474,
    lng: 3.4723,
    serviceRadiusKm: 20,
    skills: ['ac_repair', 'electrical'],
    operatingHours: {
      schedule: 'Mon – Sat: 8:00 AM – 6:00 PM',
      emergency24x7: true,
      packages: [
        {
          id: 'pkg_1',
          title: 'Split AC Servicing & Gas Refill',
          description: 'Full coil wash & pressure check',
          priceKobo: 1800000,
        },
      ],
    },
    storefrontCompleted: true,
  });

  assert.equal(updated.businessName, 'Apex Cool Engineering Ltd');
  assert.equal(updated.officeCity, 'Lagos');
  assert.equal(updated.serviceRadiusKm, 20);
  assert.equal(updated.storefrontCompleted, true);
  assert.ok(updated.skills.includes('ac_repair'));

  const feed = await providerService.dispatchFeedFor(prov.id);
  assert.equal(feed.provider?.id, prov.id);
  for (const item of feed.items) {
    assert.ok(!item.aiMatchReason.includes('AI Match'), 'Dispatch reason must not contain AI labels');
  }
});
