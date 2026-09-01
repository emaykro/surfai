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
