import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Buffer } from 'buffer';
import { Observable } from 'rxjs/Rx';
import { fromPromise } from 'rxjs/observable/fromPromise';
import { Asset, Campaign, Domain, DataComponent, Group, Software, Matrix, Technique, Mitigation, Note } from '../classes/stix';
import { TaxiiConnect, Collection } from '../utils/taxii2lib';
import { Version, VersionChangelog } from '../classes';
import { ConfigService } from './config.service';

@Injectable({
    providedIn: 'root',
})
export class DataService {
    constructor(
        private http: HttpClient,
        private configService: ConfigService
    ) {
        console.debug('initializing data service');
        this.setUpURLs(configService.versions);
    }

    public domain_backwards_compatibility = {
        'mitre-enterprise': 'enterprise-attack',
        'mitre-mobile': 'mobile-attack',
    };
    public domains: Domain[] = [];
    public versions: Version[] = [];

    /**
     * Callback functions passed to this function will be called after data is loaded
     * @param {string} domainVersionID the ID of the domain and version to load
     * @param {*} callback callback function to call when data is done loading
     */
    public onDataLoad(domainVersionID, callback) {
        this.getDomain(domainVersionID).dataLoadedCallbacks.push(callback);
    }

    /**
     * Parse the given stix bundle into the relevant data holders
     * @param domain
     * @param stixBundles
     */
    public parseBundle(domain: Domain, stixBundles: any[]): void {
        let platforms = new Set<string>();
        let matricesList: any[] = [];
        let tacticsList: any[] = [];
        let seenIDs = new Set<string>();
        for (let bundle of stixBundles) {
            let techniqueSDOs = [];
			let matrixSDOs = [];
            let idToTechniqueSDO = new Map<string, any>();
            let idToTacticSDO = new Map<string, any>();
            for (let sdo of bundle.objects) {
                // iterate through stix domain objects in the bundle
                // Filter out object not included in this domain if domains field is available
                if (!domain.isCustom && sdo.x_mitre_domains?.length > 0 && (domain.urls.length == 1 && !sdo.x_mitre_domains.includes(domain.domain_identifier))) {
                    continue;
                }

                // filter out duplicates
				if (seenIDs.has(sdo.id)) continue;
				seenIDs.add(sdo.id);

                // parse according to type
                switch (sdo.type) {
                    case 'x-mitre-data-component':
                        domain.dataComponents.push(new DataComponent(sdo, this));
                        break;
                    case 'x-mitre-data-source':
                        domain.dataSources.set(sdo.id, { name: sdo.name, external_references: sdo.external_references });
                        break;
                    case 'intrusion-set':
                        domain.groups.push(new Group(sdo, this));
                        break;
                    case 'malware':
                    case 'tool':
                        domain.software.push(new Software(sdo, this));
                        break;
                    case 'campaign':
                        domain.campaigns.push(new Campaign(sdo, this));
                        break;
                    case 'x-mitre-asset':
                        domain.assets.push(new Asset(sdo, this));
                        break;
                    case 'course-of-action':
                        domain.mitigations.push(new Mitigation(sdo, this));
                        break;
                    case 'relationship':
						this.parseRelationship(sdo, domain);
                        break;
                    case 'attack-pattern':
                        idToTechniqueSDO.set(sdo.id, sdo);
                        if (!sdo.x_mitre_is_subtechnique) {
                            techniqueSDOs.push(sdo);
                        }
                        break;
                    case 'x-mitre-tactic':
                        idToTacticSDO.set(sdo.id, sdo);
                        break;
                    case 'x-mitre-matrix':
                        matrixSDOs.push(sdo);
                        break;
                    case 'note':
                        domain.notes.push(new Note(sdo));
                        break;
                }
            }

            // create techniques
			this.createTechniques(techniqueSDOs, idToTechniqueSDO, domain);

			// parse platforms
			this.parsePlatforms(domain).forEach(platforms.add, platforms);

            // create a list of matrix and tactic SDOs
            for (let matrixSDO of matrixSDOs) {
                if (matrixSDO.x_mitre_deprecated) {
                    continue;
                }
                matricesList.push(matrixSDO);
                tacticsList.push(idToTacticSDO);
            }
        }

        // create matrices, which also creates tactics and filters techniques
		this.createMatrices(matricesList, tacticsList, domain);

        domain.platforms = Array.from(platforms); // convert to array

        // data loading complete; update watchers
        domain.dataLoaded = true;
		domain.executeCallbacks();
    }

	public createTechniques(techniqueSDOs: any, idToTechniqueSDO: Map<string, any>, domain: Domain): void {
		for (let techniqueSDO of techniqueSDOs) {
			let subtechniques: Technique[] = [];
			if (this.configService.subtechniquesEnabled) {
				if (domain.relationships.subtechniques_of.has(techniqueSDO.id)) {
					domain.relationships.subtechniques_of.get(techniqueSDO.id).forEach((sub_id) => {
						if (idToTechniqueSDO.has(sub_id)) {
							let subtechnique = new Technique(idToTechniqueSDO.get(sub_id), [], this);
							subtechniques.push(subtechnique);
							domain.subtechniques.push(subtechnique);
						}
						// else the target was revoked or deprecated and we can skip honoring the relationship
					});
				}
			}
			domain.techniques.push(new Technique(techniqueSDO, subtechniques, this));
		}
	}

	public createMatrices(matricesList: any[], tacticsList: any[], domain: Domain): void {
        for (let i = 0; i < matricesList.length; i++) {
            let techniquesList = [];
            if (matricesList[i].x_mitre_deprecated) {
                continue;
            }
            for (let technique of domain.techniques) {
				if (technique.x_mitre_domains.includes(matricesList[i].external_references[0].external_id)) {
					techniquesList.push(technique);
				}
            }
            domain.matrices.push(new Matrix(matricesList[i], tacticsList[i], techniquesList, this));
        }
	}

	public parsePlatforms(domain: Domain): Set<string> {
		let platforms = new Set<string>();
		let allTechniques = domain.techniques.concat(domain.subtechniques);

		// parse platforms
		allTechniques.forEach((technique) => {
			technique.platforms?.forEach(platforms.add, platforms);
		});

		return platforms;
	}

	public parseRelationship(sro: any, domain: Domain): void {
		// for existing keys, add the given value to the list of values
		// otherwise, add the key with the value as the first item in the list
		let addRelationshipToMap = function(map, key, value) {
			if (map.has(key)) map.get(key).push(value);
			else map.set(key, [value]);
		}

		switch (sro.relationship_type) {
			case 'subtechnique-of':
				if (!this.configService.subtechniquesEnabled) return;
				// record subtechnique:technique relationship
				addRelationshipToMap(domain.relationships['subtechniques_of'], sro.target_ref, sro.source_ref);
				break;
			case 'uses':
				if (sro.source_ref.startsWith('intrusion-set') && sro.target_ref.startsWith('attack-pattern')) {
					// record group:technique relationship
					addRelationshipToMap(domain.relationships['group_uses'], sro.source_ref, sro.target_ref);
				} else if (
					(sro.source_ref.startsWith('malware') || sro.source_ref.startsWith('tool')) &&
					sro.target_ref.startsWith('attack-pattern')
				) {
					// record software:technique relationship
					addRelationshipToMap(domain.relationships['software_uses'], sro.source_ref, sro.target_ref);
				} else if (sro.source_ref.startsWith('campaign') && sro.target_ref.startsWith('attack-pattern')) {
					// record campaign:technique relationship
					addRelationshipToMap(domain.relationships['campaign_uses'], sro.source_ref, sro.target_ref);
				}
				break;
			case 'mitigates':
				// record mitigation:technique relationship
				addRelationshipToMap(domain.relationships['mitigates'], sro.source_ref, sro.target_ref);
				break;
			case 'revoked-by':
				// record stix object: stix object relationship
				domain.relationships['revoked_by'].set(sro.source_ref, sro.target_ref);
				break;
			case 'detects':
				// record data component: technique relationship
				addRelationshipToMap(domain.relationships['component_rel'], sro.source_ref, sro.target_ref);
				break;
			case 'attributed-to':
				// record campaign:group relationship
				addRelationshipToMap(domain.relationships['campaigns_attributed_to'], sro.target_ref, sro.source_ref);
				break;
			case 'targets':
				// record technique:asset relationship
				addRelationshipToMap(domain.relationships['targeted_assets'], sro.target_ref, sro.source_ref);
				break;
		}
	}

    // Observable for data in config.json
    private configData$: Observable<Object>;

    // Observable for data
    private domainData$: Observable<Object>;

    // URLs in case config file doesn't load properly
    public latestVersion: Version = { name: 'ATT&CK v14', number: '14' };
    public lowestSupportedVersion: Version; // used by tabs component
    public enterpriseAttackURL: string = 'https://raw.githubusercontent.com/mitre/cti/master/enterprise-attack/enterprise-attack.json';
    public mobileAttackURL: string = 'https://raw.githubusercontent.com/mitre/cti/master/mobile-attack/mobile-attack.json';
    public icsAttackURL: string = 'https://raw.githubusercontent.com/mitre/cti/master/ics-attack/ics-attack.json';

    /**
     * Set up the URLs for data
     * @param {versions} list of versions and domains defined in the configuration file
     * @memberof DataService
     */
    public setUpURLs(versions: any[]) {
        versions.forEach((version: any) => {
            let v: Version = new Version(version['name'], version['version'].match(/\d+/g)[0]);
            this.versions.push(v);
            version['domains'].forEach((domain: any) => {
                let identifier = domain['identifier'];
                let domainObject = new Domain(identifier, domain['name'], v);
                if (version['authentication']) domainObject.authentication = version['authentication'];
                if (domain['taxii_url'] && domain['taxii_collection']) {
                    domainObject.taxii_url = domain['taxii_url'];
                    domainObject.taxii_collection = domain['taxii_collection'];
                } else {
                    domainObject.urls = domain['data'];
                }
                this.domains.push(domainObject);
            });
        });

        if (this.domains.length == 0) {
            // issue loading config
            this.versions.push(this.latestVersion);
            let enterpriseDomain = new Domain('enterprise-attack', 'Enterprise', this.latestVersion, [this.enterpriseAttackURL]);
            let mobileDomain = new Domain('mobile-attack', 'Mobile', this.latestVersion, [this.mobileAttackURL]);
            let icsDomain = new Domain('ics-attack', 'ICS', this.latestVersion, [this.icsAttackURL]);
            this.domains.push(...[enterpriseDomain, mobileDomain, icsDomain]);
        }

        this.lowestSupportedVersion = this.versions[this.versions.length - 1];
    }

    /**
     * Fetch the domain data from the endpoint
     */
    public getDomainData(domain: Domain, refresh: boolean = false): Observable<Object> {
        if (domain.taxii_collection && domain.taxii_url) {
            console.debug('fetching data from TAXII server');
            let conn = new TaxiiConnect(domain.taxii_url, '', '', 5000);
            let collectionInfo: any = {
                id: domain.taxii_collection,
                title: domain.name,
                description: '',
                can_read: true,
                can_write: false,
                media_types: ['application/vnd.oasis.stix+json'],
            };
            const collection = new Collection(collectionInfo, domain.taxii_url + 'stix', conn);
            this.domainData$ = Observable.forkJoin(fromPromise(collection.getObjects('', undefined)));
        } else if (refresh || !this.domainData$) {
            console.debug('retrieving data', domain.urls);
            let bundleData = [];
            const httpOptions = {
                headers: undefined,
            };
            if (domain.authentication && domain.authentication.enabled) {
                // include authorization header, if configured (integrations)
                let token = `${domain.authentication.serviceName}:${domain.authentication.apiKey}`;
                httpOptions.headers = new HttpHeaders({ Authorization: 'Basic ' + Buffer.from(token).toString('base64') });
            }
            domain.urls.forEach((url) => {
                bundleData.push(this.http.get(url, httpOptions));
            });
            this.domainData$ = Observable.forkJoin(bundleData);
        }
        return this.domainData$;
    }

    /**
     * Load and parse domain data
     */
    public loadDomainData(domainVersionID: string, refresh: boolean = false): Promise<any> {
        let dataPromise: Promise<any> = new Promise((resolve, reject) => {
            let domain = this.getDomain(domainVersionID);
            if (domain) {
                if (domain.dataLoaded && !refresh) resolve(null);
                let subscription;
                subscription = this.getDomainData(domain, refresh).subscribe({
                    next: (data: Object[]) => {
                        this.parseBundle(domain, data);
                        resolve(null);
                    },
                    complete: () => {
                        if (subscription) subscription.unsubscribe();
                    }, //prevent memory leaks
                });
            } else if (!domain) {
                // domain not defined in config
                reject(new Error("'" + domainVersionID + "' is not a valid domain & version."));
            }
        });
        return dataPromise;
    }

    /**
     * Get domain object by domain ID
     */
    public getDomain(domainVersionID: string): Domain {
        return this.domains.find((d) => d.id === domainVersionID);
    }

    /**
     * Get the ID from domain name & version
     */
    public getDomainVersionID(domain: string, versionNumber: string): string {
        if (!versionNumber) {
            // layer with no specified version defaults to current version
            versionNumber = this.versions[0].number;
        }
        return domain + '-' + versionNumber;
    }

    /**
     * Retrieve the technique object with the given attackID in the given domain/version
     */
    public getTechnique(attackID: string, domainVersionID: string) {
        let domain = this.getDomain(domainVersionID);
        let all_techniques = domain.techniques.concat(domain.subtechniques);
        return all_techniques.find((t) => t.attackID == attackID);
    }

    /**
     * Retrieves the first version defined in the config file
     */
    public getCurrentVersion() {
        return this.domains[0].version;
    }

    /**
     * Is the given version supported?
     */
    public isSupported(version: string) {
        let supported = this.versions.map((v) => v.number);
        let match = version.match(/\d+/g)[0];
        return supported.includes(match);
    }

    /**
     * Compares techniques between two ATT&CK versions and returns a set of object changes
     * @param oldDomainVersionID imported layer domain & version to upgrade from
     * @param newDomainVersionID latest ATT&CK domain & version to upgrade to
     */
    public compareVersions(oldDomainVersionID: string, newDomainVersionID: string): VersionChangelog {
        let changelog = new VersionChangelog(oldDomainVersionID, newDomainVersionID);
        let oldDomain = this.getDomain(oldDomainVersionID);
        let newDomain = this.getDomain(newDomainVersionID);

        let previousTechniques = oldDomain.techniques.concat(oldDomain.subtechniques);
        let latestTechniques = newDomain.techniques.concat(newDomain.subtechniques);

        // object lookup to increase efficiency
        let objectLookup = new Map<string, Technique>(
            latestTechniques.map((technique) => [technique.id, previousTechniques.find((p) => p.id == technique.id)])
        );

        for (let latestTechnique of latestTechniques) {
            if (!latestTechnique) continue;

            let prevTechnique = objectLookup.get(latestTechnique.id);
            if (!prevTechnique) {
				if (latestTechnique.deprecated || latestTechnique.revoked) {
					// object doesn't exist in previous version, but is deprecated or revoked
					// in the latest version
					// this case is unlikely to occur and indicates that something has
					// gone wrong in the data, such as the case in which a sub-technique
					// was deprecated, had its ties erroneously severed with its parent
					// and therefore, cannot be parsed correctly
					continue;
				}

                // object doesn't exist in previous version, added to latest version
                changelog.additions.push(latestTechnique.attackID);
            } else if (latestTechnique.modified == prevTechnique.modified) {
                if (prevTechnique.revoked || prevTechnique.deprecated) {
                    // object is revoked or deprecated, ignore
                    continue;
                } else {
                    // no changes made to the object
                    changelog.unchanged.push(latestTechnique.attackID);
                }
            } else {
                // changes were made to the object
                if (latestTechnique.revoked && !prevTechnique.revoked) {
                    // object was revoked since the previous version
                    changelog.revocations.push(latestTechnique.attackID);
                } else if (latestTechnique.revoked && prevTechnique.revoked) {
                    // both objects are revoked, ignore
                    continue;
                } else if (latestTechnique.deprecated && !prevTechnique.deprecated) {
                    // object was deprecated since the previous version
                    changelog.deprecations.push(latestTechnique.attackID);
                } else if (latestTechnique.deprecated && prevTechnique.deprecated) {
                    // both objects are deprecated, ignore
                    continue;
                } else if (latestTechnique.compareVersion(prevTechnique) != 0) {
                    // version number changed
                    changelog.changes.push(latestTechnique.attackID);
                } else {
                    // minor change
                    changelog.minor_changes.push(latestTechnique.attackID);
                }
            }
        }
        return changelog;
    }
}

export interface ServiceAuth {
    enabled: boolean;
    serviceName: string;
    apiKey: string;
}
