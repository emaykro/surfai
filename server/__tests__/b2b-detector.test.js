"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { classifyAsnOrg, cleanCompanyName } = require("../features/b2b-detector");

describe("B2B Corporate Detector", () => {
  test("correctly identifies consumer ISPs", () => {
    assert.equal(classifyAsnOrg("PJSC Rostelecom"), "consumer_isp");
    assert.equal(classifyAsnOrg("Mobile TeleSystems OJSC"), "consumer_isp");
    assert.equal(classifyAsnOrg("Megafon Public Joint Stock Company"), "consumer_isp");
    assert.equal(classifyAsnOrg("Comcast Cable Communications, LLC"), "consumer_isp");
  });

  test("correctly identifies datacenters and clouds", () => {
    assert.equal(classifyAsnOrg("Hetzner Online GmbH"), "datacenter");
    assert.equal(classifyAsnOrg("DigitalOcean, LLC"), "datacenter");
    assert.equal(classifyAsnOrg("Selectel LLC"), "datacenter");
    assert.equal(classifyAsnOrg("Amazon.com, Inc."), "datacenter");
  });

  test("identifies corporate B2B enterprises", () => {
    assert.equal(classifyAsnOrg("Sberbank of Russia PJSC"), "b2b_corporate");
    assert.equal(classifyAsnOrg("Gazprom Neft PJSC"), "b2b_corporate");
    assert.equal(classifyAsnOrg("Severstal Mining Company JSC"), "b2b_corporate");
    assert.equal(classifyAsnOrg("Nornickel Group"), "b2b_corporate");
  });

  test("cleans legal abbreviations from company names", () => {
    assert.equal(cleanCompanyName("ПАО Сбербанк"), "Сбербанк");
    assert.equal(cleanCompanyName("PJSC Gazprom Neft"), "Gazprom Neft");
    assert.equal(cleanCompanyName("ООО «ЛУЧ КЛИНИНГ»"), "ЛУЧ КЛИНИНГ");
  });
});

describe("B2B classifier requires positive evidence", () => {
  test("an unrecognised org is unknown, not corporate", () => {
    // The old fallback returned b2b_corporate here, so every regional ISP the
    // pattern lists had never heard of became a CRM lead.
    assert.equal(classifyAsnOrg("Kvant-Service"), "unknown");
    assert.equal(classifyAsnOrg("Uralvest"), "unknown");
    assert.equal(classifyAsnOrg("AS-TRIVON"), "unknown");
  });

  test("unnamed regional ISPs are caught by operator vocabulary", () => {
    assert.equal(classifyAsnOrg("Ivanovo Telecom"), "consumer_isp");
    assert.equal(classifyAsnOrg("ООО Городские Сети"), "consumer_isp");
    assert.equal(classifyAsnOrg("Regional Broadband Networks"), "consumer_isp");
    assert.equal(classifyAsnOrg("ЗАО Связь-Регион"), "consumer_isp");
  });

  test("network vocabulary outranks a legal form", () => {
    // Most small ISPs are registered as ООО/LLC; the legal marker alone must
    // not promote them to corporate.
    assert.equal(classifyAsnOrg("OOO Regional Telecom"), "consumer_isp");
    assert.equal(classifyAsnOrg("Sibir Internet LLC"), "consumer_isp");
  });

  test("Cyrillic legal forms are matched as whole tokens", () => {
    assert.equal(classifyAsnOrg("ООО Ромашка"), "b2b_corporate");
    assert.equal(classifyAsnOrg("Череповецкий Завод"), "b2b_corporate");
    // "АО" must not match inside an unrelated word.
    assert.equal(classifyAsnOrg("Хаос"), "unknown");
  });

  test("blank and junk input stays unknown", () => {
    assert.equal(classifyAsnOrg(null), "unknown");
    assert.equal(classifyAsnOrg(""), "unknown");
    assert.equal(classifyAsnOrg("  "), "unknown");
    assert.equal(classifyAsnOrg(42), "unknown");
  });

  test("geo flags still take precedence", () => {
    assert.equal(classifyAsnOrg("ООО Ромашка", true, false), "datacenter");
    assert.equal(classifyAsnOrg("ООО Ромашка", false, true), "consumer_isp");
  });
});
