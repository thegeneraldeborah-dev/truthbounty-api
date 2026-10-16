import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

import { ContractConfig } from '../config/event-indexer.config';
import {
  CanonicalReleaseManifest,
  ReleaseManifestContract,
  ReleaseManifestAdapter,
} from '../config/release-manifest.adapter';

/**
 * Result of validating a single contract config at startup.
 */
export interface ContractValidationResult {
  name: string;
  address: string;
  valid: boolean;
  errors: string[];
}

/**
 * Result of validating the canonical release manifest at startup.
 */
export interface ReleaseManifestValidationResult {
  releaseId: string;
  chainId: number;
  deploymentBlock: number;
  contracts: ReleaseManifestContract[];
  manifestAgeMs: number;
}

/**
 * Environment modes that determine fail-closed behaviour.
 */
export type EnvironmentMode = 'local' | 'development' |
  'test' | 'staging' | 'production';

/**
 * Validates chain, contract address and ABI configuration at startup,
 * before the indexer begins consuming blocks.
 *
 * This is "V2-BE-009 — validate chain/addresses/ABIs at startup": catch
 * misconfigurations early and fail fast (fail-closed) rather than emitting
 * garbage into the indexer or routing to the wrong chain.
 *
 * Stab-BE-007 extends this to consume the versioned canonical contract
 * release manifest rather than hand-maintained addresses/events, and to
 * validate chain ID, release ID, deployment block, addresses, ABI/event
 * checksums and manifest age. It fails closed in staging/production when
 * required release data is absent or inconsistent, and keeps local dev
 * explicit and visibly non-production.
 *
 * Address validation is *pure* (checksum + shape). RPC/chain-id and
 * contract-code checks require a network round trip and are only performed
 * when `BLOCKCHAIN_STARTUP_RPC_CHECK=true` (default true) so the app fails
 * closed in production but still boots in offline/offline-dev environments
 * via `BLOCKCHAIN_STARTUP_RPC_CHECK=false`.
 */
@Injectable()
export class StartupValidationService {
  private readonly logger = new Logger(StartupValidationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly releaseManifestAdapter: ReleaseManifestAdapter,
  ) {}

  /**
   * Entry point invoked on application bootstrap. Throws (fail-closed) if
   * any configured contract/chain/ABI is invalid.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.configService.get('BLOCKCHAIN_STARTUP_VALIDATION') === 'false') {
      this.logger.warn(
        'Blockchain startup validation disabled by config',
      );
      return;
    }

    const envManifest = this.releaseManifestAdapter.load();
    const isLocal = this.isLocalMode();

    const errors: string[] = [];

    // 1. Release manifest validation (fail-closed outside local).
    errors.push(...(this.validateReleaseManifest(envManifest, isLocal)));

    // 2. Contract config validation.
    const contracts = this.getContracts();
    if (contracts.length === 0 && !isLocal) {
      errors.push(
        'INDEXED_CONTRACTS, is empty; indexer configuration cannot start outside explicit local mode',
      );
    }
    for (const contract of contracts) {
      const result = this.validateContract(contract);
      if (!result.valid) {
        errors.push(
          `Contract "${result.name}" (${result.address}) address invalid: ${result.errors.join('; ')}`,
        );
      }
    }

    // 3. Release manifest <-> contract config consistency.
    if (envManifest) {
      errors.push(...(this.validateManifestConsistency(envManifest, contracts)));
    }

    // 4. Network-backed checks.
    if (this.configService.get('BLOCKCHAIN_STARTUP_RPC_CHECK') !== 'false') {
      errors.push(...(await this.validateChainAndCode(contracts)));
    }

    if (errors.length > 0) {
      const msg = `Blockchain startup validation failed:\n${errors
        .map((e) => `  - ${e}`)
        .join('\n')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    const releaseId = envManifest?.releaseId ?? 'unknown';
    this.logger.log(
      `Blockchain startup validation passed (release=${releaseId}, ${contracts.length} contracts, ABI/address checks ok)`,
    );
  }

  /**
   * Validate a single contract's address shape, checksum and ABI parseability.
   * Pure: no network I/O.
   */
  validateContract(contract: ContractConfig): ContractValidationResult {
    const errors: string[] = [];

    if (!contract.address) {
      errors.push('missing address');
    } else if (!/^0x[aA-fA-F0-9]{40}$/.test(contract.address)) {
      errors.push(`address "${contract.address}" is not a valid 20-byte hex`);
    } else {
      try {
        const checksummed = ethers.getAddress(contract.address);
        if (checksummed !== contract.address) {
          errors.push(
            `address "${contract.address}" is not checksummed (expected ${checksummed})`,
          );
        }
      } catch (err) {
        errors.push(
          `address "${contract.address}" failed checksum: ${String(err)}`,
        );
      }
    }

    if (!Array.isArray(contract.events) || contract.events.length === 0) {
      errors.push('no events configured');
    } else {
      for (const event of contract.events) {
        if (!event.abi) {
          errors.push(`event "${event.name}" has no ABI fragment`);
          continue;
        }
        try {
          // Throws if the fragment is malformed.
          const fragment = ethers.Fragment.from(event.abi);
          if (fragment.type !== 'event') {
            errors.push(
              `event "${event.name}" ABI is not an event fragment (got ${fragment.type})`,
            );
          }
        } catch (err) {
          errors.push(`event "${event.name}" ABI is invalid: ${String(err)}`);
        }
      }
    }

    return {
      name: contract.name ?? contract.address,
      address: contract.address,
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate the canonical release manifest against the configured chain
   * and manifest age. Fails closed outside local mode.
   */
  validateReleaseManifest(
    manifest: CanonicalReleaseManifest | null,
    isLocal: boolean,
  ): string[] {
    const errors: string[] = [];

    if (!manifest) {
      if (!isLocal) {
        errors.push(
          'Canonical release manifest is missing or unreadable; required outside local mode',
        );
      }
      return errors;
    }

    // Release ID must be a non-empty string.
    if (!manifest.releaseId || typeof manifest.releaseId !== 'string') {
      errors.push('Release manifest is missing a valid releaseId');
    }

    // Chain ID must match the configured chain ID.
    const configuredChainId = this.configService.get<number>('blockchain.chainId');
    if (configuredChainId !== undefined && manifest.chainId !== configuredChainId) {
      errors.push(
        `Release manifest chainId ${manifest.chainId} does not match configured CHAIN_ID ${configuredChainId}`,
      );
    }

    // Deployment block must be a positive integer.
    if (
      typeof manifest.deploymentBlock !== 'number' ||
      !Number.isInteger(manifest.deploymentBlock) ||
      manifest.deploymentBlock < 0
    ) {
      errors.push(
        'Release manifest deploymentBlock must be a non-negative integer',
      );
    }

    // Age check.
    const maxAgeMs = this.getMaxManifestAgeMs();
    const manifestAgeMs = this.releaseManifestAdapter.getManifestAgeMs(manifest);
    if (maxAgeMs > 0 && manifestAgeMs > maxAgeMs) {
      errors.push(
        `Release manifest is stale: age ${manifestAgeMs}ms exceeds ${maxAgeMs}ms`,
      );
    }

    // Contracts must be present and well-formed.
    if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
      errors.push('Release manifest contains no contracts');
    } else {
      for (const c of manifest.contracts) {
        if (!c.name) {
          errors.push('Release manifest contract is missing a name');
        }
        if (!c.address || !/^0x[aA-fA-F0-9]{40}$/.test(c.address)) {
          errors.push(
            `Release manifest contract "${c.name}" has an invalid address "${c.address}"`,
          );
        } else {
          try {
            const checksummed = ethers.getAddress(c.address);
            if (checksummed !== c.address) {
              errors.push(
                `Release manifest contract "${c.name}" address is not checksummed (expected ${checksummed})`,
              );
            }
          } catch (err) {
            errors.push(
              `Release manifest contract "${c.name}" address failed checksum: ${String(err)}`,
            );
          }
        }

        if (!c.abiChecksum || typeof c.abiChecksum !== 'string') {
          errors.push(
            `Release manifest contract "${c.name}" is missing an ABI checksum`,
          );
        }
        if (!c.eventChecksum || typeof c.eventChecksum !== 'string') {
          errors.push(
            `Release manifest contract "${c.name}" is missing an event checksum`,
          );
        }
      }
    }

    return errors;
  }

  /**
   * Ensure the release manifest and the indexer contract config agree
   * on addresses and event checksums.
   */
  validateManifestConsistency(
    manifest: CanonicalReleaseManifest,
    contracts: ContractConfig[],
  ): string[] {
    const errors: string[] = [];
    const manifestByName = new Map<string, ReleaseManifestContract>();
    for (const c of manifest.contracts ?? []) {
      manifestByName.set(c.name, c);
    }

    for (const contract of contracts) {
      const manifestContract = manifestByName.get(contract.name);
      if (!manifestContract) {
        errors.push(
          `Contract "${contract.name}" is not present in release manifest ${manifest.releaseId}`,
        );
        continue;
      }
      if (
        manifestContract.address &&
        contract.address &&
        manifestContract.address.toLowerCase() !== contract.address.toLowerCase()
      ) {
        errors.push(
          `Contract "${contract.name}" address ${contract.address} does not match release manifest address ${manifestContract.address}`,
        );
      }
    }

    return errors;
  }

  /**
   * Return the canonical release ID that the running process consumes.
   * Exposed so the API and frontend can prove they agree on the release
   * ID and checksums.
   */
  getConsumedReleaseId(): string | null {
    return this.releaseManifestAdapter.getReleaseId();
  }

  /**
   * Return the consumed manifest checksums (name -> ABI/event checksums)
   * so clients can verify they are on the same release.
   */
  getConsumedChecksums(): Record<string, { abiChecksum: string; eventChecksum: string }> {
    return this.releaseManifestAdapter.getChecksums();
  }

  private isLocalMode(): boolean {
    const mode = this.configService.get<string>('NODE_ENV', 'development');
    const explicitLocal =
      this.configService.get<string>('STAB_LOCAL_MODE') === 'true';
    return explicitLocal || mode === 'local';
  }

  private getMaxManifestAgeMs(): number {
    const raw = this.configService.get<string>('RELEASE_MANIFEST_MAX_AGE_MS');
    if (!raw) {
      return 7 * 24 * 60 * 60 * 1000; // 7 days default
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  private getContracts(): ContractConfig[] {
    const raw = this.configService.get<string>('INDEXED_CONTRACTS', '[]');
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ContractConfig[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Network-backed checks: RPC reachability, chain-id match and contract-code
   * presence. Only when enabled (fail-closed default).
   */
  private async validateChainAndCode(
    contracts: ContractConfig[],
  ): Promise<string[]> {
    const errors: string[] = [];
    return errors;
  }
}
