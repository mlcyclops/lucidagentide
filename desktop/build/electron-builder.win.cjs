// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/electron-builder.win.cjs - P-RELEASE.6 (ADR-0447): the Agent Windows build config.
//
// Exactly desktop/package.json's build block, plus Azure Artifact Signing when CI turns it on
// (win-signing.cjs). package.json stays THE base; this file exists only because a JSON block cannot read
// the environment, and the signing switch has to.

const { withWindowsSigning } = require("./win-signing.cjs");

module.exports = withWindowsSigning(require("../package.json").build);
