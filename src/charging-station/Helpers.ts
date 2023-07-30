import { createHash, randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import chalk from 'chalk';
import {
  addDays,
  addSeconds,
  addWeeks,
  differenceInDays,
  differenceInSeconds,
  differenceInWeeks,
  isAfter,
  isBefore,
  isDate,
  isWithinInterval,
  toDate,
} from 'date-fns';

import type { ChargingStation } from './ChargingStation';
import { getConfigurationKey } from './ConfigurationKeyUtils';
import { BaseError } from '../exception';
import {
  AmpereUnits,
  AvailabilityType,
  type BootNotificationRequest,
  BootReasonEnumType,
  type ChargingProfile,
  ChargingProfileKindType,
  ChargingRateUnitType,
  type ChargingSchedulePeriod,
  type ChargingStationInfo,
  type ChargingStationTemplate,
  ChargingStationWorkerMessageEvents,
  ConnectorPhaseRotation,
  type ConnectorStatus,
  ConnectorStatusEnum,
  CurrentType,
  type EvseTemplate,
  type OCPP16BootNotificationRequest,
  type OCPP20BootNotificationRequest,
  OCPPVersion,
  RecurrencyKindType,
  StandardParametersKey,
  SupportedFeatureProfiles,
  Voltage,
} from '../types';
import {
  ACElectricUtils,
  Constants,
  DCElectricUtils,
  cloneObject,
  convertToDate,
  convertToInt,
  isArraySorted,
  isEmptyObject,
  isEmptyString,
  isNotEmptyArray,
  isNotEmptyString,
  isNullOrUndefined,
  isUndefined,
  isValidTime,
  logger,
  secureRandom,
} from '../utils';

const moduleName = 'Helpers';

export const getChargingStationId = (
  index: number,
  stationTemplate: ChargingStationTemplate,
): string => {
  // In case of multiple instances: add instance index to charging station id
  const instanceIndex = process.env.CF_INSTANCE_INDEX ?? 0;
  const idSuffix = stationTemplate?.nameSuffix ?? '';
  const idStr = `000000000${index.toString()}`;
  return stationTemplate?.fixedName
    ? stationTemplate.baseName
    : `${stationTemplate.baseName}-${instanceIndex.toString()}${idStr.substring(
        idStr.length - 4,
      )}${idSuffix}`;
};

export const countReservableConnectors = (connectors: Map<number, ConnectorStatus>) => {
  let reservableConnectors = 0;
  for (const [connectorId, connectorStatus] of connectors) {
    if (connectorId === 0) {
      continue;
    }
    if (connectorStatus.status === ConnectorStatusEnum.Available) {
      ++reservableConnectors;
    }
  }
  return reservableConnectors;
};

export const getHashId = (index: number, stationTemplate: ChargingStationTemplate): string => {
  const chargingStationInfo = {
    chargePointModel: stationTemplate.chargePointModel,
    chargePointVendor: stationTemplate.chargePointVendor,
    ...(!isUndefined(stationTemplate.chargeBoxSerialNumberPrefix) && {
      chargeBoxSerialNumber: stationTemplate.chargeBoxSerialNumberPrefix,
    }),
    ...(!isUndefined(stationTemplate.chargePointSerialNumberPrefix) && {
      chargePointSerialNumber: stationTemplate.chargePointSerialNumberPrefix,
    }),
    ...(!isUndefined(stationTemplate.meterSerialNumberPrefix) && {
      meterSerialNumber: stationTemplate.meterSerialNumberPrefix,
    }),
    ...(!isUndefined(stationTemplate.meterType) && {
      meterType: stationTemplate.meterType,
    }),
  };
  return createHash(Constants.DEFAULT_HASH_ALGORITHM)
    .update(`${JSON.stringify(chargingStationInfo)}${getChargingStationId(index, stationTemplate)}`)
    .digest('hex');
};

export const checkChargingStation = (
  chargingStation: ChargingStation,
  logPrefix: string,
): boolean => {
  if (chargingStation.started === false && chargingStation.starting === false) {
    logger.warn(`${logPrefix} charging station is stopped, cannot proceed`);
    return false;
  }
  return true;
};

export const getPhaseRotationValue = (
  connectorId: number,
  numberOfPhases: number,
): string | undefined => {
  // AC/DC
  if (connectorId === 0 && numberOfPhases === 0) {
    return `${connectorId}.${ConnectorPhaseRotation.RST}`;
  } else if (connectorId > 0 && numberOfPhases === 0) {
    return `${connectorId}.${ConnectorPhaseRotation.NotApplicable}`;
    // AC
  } else if (connectorId > 0 && numberOfPhases === 1) {
    return `${connectorId}.${ConnectorPhaseRotation.NotApplicable}`;
  } else if (connectorId > 0 && numberOfPhases === 3) {
    return `${connectorId}.${ConnectorPhaseRotation.RST}`;
  }
};

export const getMaxNumberOfEvses = (evses: Record<string, EvseTemplate>): number => {
  if (!evses) {
    return -1;
  }
  return Object.keys(evses).length;
};

const getMaxNumberOfConnectors = (connectors: Record<string, ConnectorStatus>): number => {
  if (!connectors) {
    return -1;
  }
  return Object.keys(connectors).length;
};

export const getBootConnectorStatus = (
  chargingStation: ChargingStation,
  connectorId: number,
  connectorStatus: ConnectorStatus,
): ConnectorStatusEnum => {
  let connectorBootStatus: ConnectorStatusEnum;
  if (
    !connectorStatus?.status &&
    (chargingStation.isChargingStationAvailable() === false ||
      chargingStation.isConnectorAvailable(connectorId) === false)
  ) {
    connectorBootStatus = ConnectorStatusEnum.Unavailable;
  } else if (!connectorStatus?.status && connectorStatus?.bootStatus) {
    // Set boot status in template at startup
    connectorBootStatus = connectorStatus?.bootStatus;
  } else if (connectorStatus?.status) {
    // Set previous status at startup
    connectorBootStatus = connectorStatus?.status;
  } else {
    // Set default status
    connectorBootStatus = ConnectorStatusEnum.Available;
  }
  return connectorBootStatus;
};

export const checkTemplate = (
  stationTemplate: ChargingStationTemplate,
  logPrefix: string,
  templateFile: string,
): void => {
  if (isNullOrUndefined(stationTemplate)) {
    const errorMsg = `Failed to read charging station template file ${templateFile}`;
    logger.error(`${logPrefix} ${errorMsg}`);
    throw new BaseError(errorMsg);
  }
  if (isEmptyObject(stationTemplate)) {
    const errorMsg = `Empty charging station information from template file ${templateFile}`;
    logger.error(`${logPrefix} ${errorMsg}`);
    throw new BaseError(errorMsg);
  }
  if (isEmptyObject(stationTemplate.AutomaticTransactionGenerator!)) {
    stationTemplate.AutomaticTransactionGenerator = Constants.DEFAULT_ATG_CONFIGURATION;
    logger.warn(
      `${logPrefix} Empty automatic transaction generator configuration from template file ${templateFile}, set to default: %j`,
      Constants.DEFAULT_ATG_CONFIGURATION,
    );
  }
  if (isNullOrUndefined(stationTemplate.idTagsFile) || isEmptyString(stationTemplate.idTagsFile)) {
    logger.warn(
      `${logPrefix} Missing id tags file in template file ${templateFile}. That can lead to issues with the Automatic Transaction Generator`,
    );
  }
};

export const checkConnectorsConfiguration = (
  stationTemplate: ChargingStationTemplate,
  logPrefix: string,
  templateFile: string,
): {
  configuredMaxConnectors: number;
  templateMaxConnectors: number;
  templateMaxAvailableConnectors: number;
} => {
  const configuredMaxConnectors = getConfiguredNumberOfConnectors(stationTemplate);
  checkConfiguredMaxConnectors(configuredMaxConnectors, logPrefix, templateFile);
  const templateMaxConnectors = getMaxNumberOfConnectors(stationTemplate.Connectors!);
  checkTemplateMaxConnectors(templateMaxConnectors, logPrefix, templateFile);
  const templateMaxAvailableConnectors = stationTemplate.Connectors![0]
    ? templateMaxConnectors - 1
    : templateMaxConnectors;
  if (
    configuredMaxConnectors > templateMaxAvailableConnectors &&
    !stationTemplate?.randomConnectors
  ) {
    logger.warn(
      `${logPrefix} Number of connectors exceeds the number of connector configurations in template ${templateFile}, forcing random connector configurations affectation`,
    );
    stationTemplate.randomConnectors = true;
  }
  return { configuredMaxConnectors, templateMaxConnectors, templateMaxAvailableConnectors };
};

export const checkStationInfoConnectorStatus = (
  connectorId: number,
  connectorStatus: ConnectorStatus,
  logPrefix: string,
  templateFile: string,
): void => {
  if (!isNullOrUndefined(connectorStatus?.status)) {
    logger.warn(
      `${logPrefix} Charging station information from template ${templateFile} with connector id ${connectorId} status configuration defined, undefine it`,
    );
    delete connectorStatus.status;
  }
};

export const buildConnectorsMap = (
  connectors: Record<string, ConnectorStatus>,
  logPrefix: string,
  templateFile: string,
): Map<number, ConnectorStatus> => {
  const connectorsMap = new Map<number, ConnectorStatus>();
  if (getMaxNumberOfConnectors(connectors) > 0) {
    for (const connector in connectors) {
      const connectorStatus = connectors[connector];
      const connectorId = convertToInt(connector);
      checkStationInfoConnectorStatus(connectorId, connectorStatus, logPrefix, templateFile);
      connectorsMap.set(connectorId, cloneObject<ConnectorStatus>(connectorStatus));
    }
  } else {
    logger.warn(
      `${logPrefix} Charging station information from template ${templateFile} with no connectors, cannot build connectors map`,
    );
  }
  return connectorsMap;
};

export const initializeConnectorsMapStatus = (
  connectors: Map<number, ConnectorStatus>,
  logPrefix: string,
): void => {
  for (const connectorId of connectors.keys()) {
    if (connectorId > 0 && connectors.get(connectorId)?.transactionStarted === true) {
      logger.warn(
        `${logPrefix} Connector id ${connectorId} at initialization has a transaction started with id ${connectors.get(
          connectorId,
        )?.transactionId}`,
      );
    }
    if (connectorId === 0) {
      connectors.get(connectorId)!.availability = AvailabilityType.Operative;
      if (isUndefined(connectors.get(connectorId)?.chargingProfiles)) {
        connectors.get(connectorId)!.chargingProfiles = [];
      }
    } else if (
      connectorId > 0 &&
      isNullOrUndefined(connectors.get(connectorId)?.transactionStarted)
    ) {
      initializeConnectorStatus(connectors.get(connectorId)!);
    }
  }
};

export const resetConnectorStatus = (connectorStatus: ConnectorStatus): void => {
  connectorStatus.idTagLocalAuthorized = false;
  connectorStatus.idTagAuthorized = false;
  connectorStatus.transactionRemoteStarted = false;
  connectorStatus.transactionStarted = false;
  delete connectorStatus?.transactionStart;
  delete connectorStatus?.transactionId;
  delete connectorStatus?.localAuthorizeIdTag;
  delete connectorStatus?.authorizeIdTag;
  delete connectorStatus?.transactionIdTag;
  connectorStatus.transactionEnergyActiveImportRegisterValue = 0;
  delete connectorStatus?.transactionBeginMeterValue;
};

export const createBootNotificationRequest = (
  stationInfo: ChargingStationInfo,
  bootReason: BootReasonEnumType = BootReasonEnumType.PowerUp,
): BootNotificationRequest => {
  const ocppVersion = stationInfo.ocppVersion ?? OCPPVersion.VERSION_16;
  switch (ocppVersion) {
    case OCPPVersion.VERSION_16:
      return {
        chargePointModel: stationInfo.chargePointModel,
        chargePointVendor: stationInfo.chargePointVendor,
        ...(!isUndefined(stationInfo.chargeBoxSerialNumber) && {
          chargeBoxSerialNumber: stationInfo.chargeBoxSerialNumber,
        }),
        ...(!isUndefined(stationInfo.chargePointSerialNumber) && {
          chargePointSerialNumber: stationInfo.chargePointSerialNumber,
        }),
        ...(!isUndefined(stationInfo.firmwareVersion) && {
          firmwareVersion: stationInfo.firmwareVersion,
        }),
        ...(!isUndefined(stationInfo.iccid) && { iccid: stationInfo.iccid }),
        ...(!isUndefined(stationInfo.imsi) && { imsi: stationInfo.imsi }),
        ...(!isUndefined(stationInfo.meterSerialNumber) && {
          meterSerialNumber: stationInfo.meterSerialNumber,
        }),
        ...(!isUndefined(stationInfo.meterType) && {
          meterType: stationInfo.meterType,
        }),
      } as OCPP16BootNotificationRequest;
    case OCPPVersion.VERSION_20:
    case OCPPVersion.VERSION_201:
      return {
        reason: bootReason,
        chargingStation: {
          model: stationInfo.chargePointModel,
          vendorName: stationInfo.chargePointVendor,
          ...(!isUndefined(stationInfo.firmwareVersion) && {
            firmwareVersion: stationInfo.firmwareVersion,
          }),
          ...(!isUndefined(stationInfo.chargeBoxSerialNumber) && {
            serialNumber: stationInfo.chargeBoxSerialNumber,
          }),
          ...((!isUndefined(stationInfo.iccid) || !isUndefined(stationInfo.imsi)) && {
            modem: {
              ...(!isUndefined(stationInfo.iccid) && { iccid: stationInfo.iccid }),
              ...(!isUndefined(stationInfo.imsi) && { imsi: stationInfo.imsi }),
            },
          }),
        },
      } as OCPP20BootNotificationRequest;
  }
};

export const warnTemplateKeysDeprecation = (
  stationTemplate: ChargingStationTemplate,
  logPrefix: string,
  templateFile: string,
) => {
  const templateKeys: { deprecatedKey: string; key?: string }[] = [
    { deprecatedKey: 'supervisionUrl', key: 'supervisionUrls' },
    { deprecatedKey: 'authorizationFile', key: 'idTagsFile' },
    { deprecatedKey: 'payloadSchemaValidation', key: 'ocppStrictCompliance' },
  ];
  for (const templateKey of templateKeys) {
    warnDeprecatedTemplateKey(
      stationTemplate,
      templateKey.deprecatedKey,
      logPrefix,
      templateFile,
      !isUndefined(templateKey.key) ? `Use '${templateKey.key}' instead` : undefined,
    );
    convertDeprecatedTemplateKey(stationTemplate, templateKey.deprecatedKey, templateKey.key);
  }
};

export const stationTemplateToStationInfo = (
  stationTemplate: ChargingStationTemplate,
): ChargingStationInfo => {
  stationTemplate = cloneObject<ChargingStationTemplate>(stationTemplate);
  delete stationTemplate.power;
  delete stationTemplate.powerUnit;
  delete stationTemplate.Connectors;
  delete stationTemplate.Evses;
  delete stationTemplate.Configuration;
  delete stationTemplate.AutomaticTransactionGenerator;
  delete stationTemplate.chargeBoxSerialNumberPrefix;
  delete stationTemplate.chargePointSerialNumberPrefix;
  delete stationTemplate.meterSerialNumberPrefix;
  return stationTemplate as ChargingStationInfo;
};

export const createSerialNumber = (
  stationTemplate: ChargingStationTemplate,
  stationInfo: ChargingStationInfo,
  params: {
    randomSerialNumberUpperCase?: boolean;
    randomSerialNumber?: boolean;
  } = {
    randomSerialNumberUpperCase: true,
    randomSerialNumber: true,
  },
): void => {
  params = { ...{ randomSerialNumberUpperCase: true, randomSerialNumber: true }, ...params };
  const serialNumberSuffix = params?.randomSerialNumber
    ? getRandomSerialNumberSuffix({
        upperCase: params.randomSerialNumberUpperCase,
      })
    : '';
  isNotEmptyString(stationTemplate?.chargePointSerialNumberPrefix) &&
    (stationInfo.chargePointSerialNumber = `${stationTemplate.chargePointSerialNumberPrefix}${serialNumberSuffix}`);
  isNotEmptyString(stationTemplate?.chargeBoxSerialNumberPrefix) &&
    (stationInfo.chargeBoxSerialNumber = `${stationTemplate.chargeBoxSerialNumberPrefix}${serialNumberSuffix}`);
  isNotEmptyString(stationTemplate?.meterSerialNumberPrefix) &&
    (stationInfo.meterSerialNumber = `${stationTemplate.meterSerialNumberPrefix}${serialNumberSuffix}`);
};

export const propagateSerialNumber = (
  stationTemplate: ChargingStationTemplate,
  stationInfoSrc: ChargingStationInfo,
  stationInfoDst: ChargingStationInfo,
) => {
  if (!stationInfoSrc || !stationTemplate) {
    throw new BaseError(
      'Missing charging station template or existing configuration to propagate serial number',
    );
  }
  stationTemplate?.chargePointSerialNumberPrefix && stationInfoSrc?.chargePointSerialNumber
    ? (stationInfoDst.chargePointSerialNumber = stationInfoSrc.chargePointSerialNumber)
    : stationInfoDst?.chargePointSerialNumber && delete stationInfoDst.chargePointSerialNumber;
  stationTemplate?.chargeBoxSerialNumberPrefix && stationInfoSrc?.chargeBoxSerialNumber
    ? (stationInfoDst.chargeBoxSerialNumber = stationInfoSrc.chargeBoxSerialNumber)
    : stationInfoDst?.chargeBoxSerialNumber && delete stationInfoDst.chargeBoxSerialNumber;
  stationTemplate?.meterSerialNumberPrefix && stationInfoSrc?.meterSerialNumber
    ? (stationInfoDst.meterSerialNumber = stationInfoSrc.meterSerialNumber)
    : stationInfoDst?.meterSerialNumber && delete stationInfoDst.meterSerialNumber;
};

export const hasFeatureProfile = (
  chargingStation: ChargingStation,
  featureProfile: SupportedFeatureProfiles,
): boolean | undefined => {
  return getConfigurationKey(
    chargingStation,
    StandardParametersKey.SupportedFeatureProfiles,
  )?.value?.includes(featureProfile);
};

export const getAmperageLimitationUnitDivider = (stationInfo: ChargingStationInfo): number => {
  let unitDivider = 1;
  switch (stationInfo.amperageLimitationUnit) {
    case AmpereUnits.DECI_AMPERE:
      unitDivider = 10;
      break;
    case AmpereUnits.CENTI_AMPERE:
      unitDivider = 100;
      break;
    case AmpereUnits.MILLI_AMPERE:
      unitDivider = 1000;
      break;
  }
  return unitDivider;
};

export const getChargingStationConnectorChargingProfilesPowerLimit = (
  chargingStation: ChargingStation,
  connectorId: number,
): number | undefined => {
  let limit: number | undefined, matchingChargingProfile: ChargingProfile | undefined;
  // Get charging profiles for connector id and sort by stack level
  const chargingProfiles =
    cloneObject<ChargingProfile[]>(
      chargingStation.getConnectorStatus(connectorId)!.chargingProfiles!,
    )?.sort((a, b) => b.stackLevel - a.stackLevel) ?? [];
  // Get charging profiles on connector 0 and sort by stack level
  if (isNotEmptyArray(chargingStation.getConnectorStatus(0)?.chargingProfiles)) {
    chargingProfiles.push(
      ...cloneObject<ChargingProfile[]>(
        chargingStation.getConnectorStatus(0)!.chargingProfiles!,
      ).sort((a, b) => b.stackLevel - a.stackLevel),
    );
  }
  if (isNotEmptyArray(chargingProfiles)) {
    const result = getLimitFromChargingProfiles(
      chargingStation,
      connectorId,
      chargingProfiles,
      chargingStation.logPrefix(),
    );
    if (!isNullOrUndefined(result)) {
      limit = result?.limit;
      matchingChargingProfile = result?.matchingChargingProfile;
      switch (chargingStation.getCurrentOutType()) {
        case CurrentType.AC:
          limit =
            matchingChargingProfile?.chargingSchedule?.chargingRateUnit ===
            ChargingRateUnitType.WATT
              ? limit
              : ACElectricUtils.powerTotal(
                  chargingStation.getNumberOfPhases(),
                  chargingStation.getVoltageOut(),
                  limit!,
                );
          break;
        case CurrentType.DC:
          limit =
            matchingChargingProfile?.chargingSchedule?.chargingRateUnit ===
            ChargingRateUnitType.WATT
              ? limit
              : DCElectricUtils.power(chargingStation.getVoltageOut(), limit!);
      }
      const connectorMaximumPower =
        chargingStation.getMaximumPower() / chargingStation.powerDivider;
      if (limit! > connectorMaximumPower) {
        logger.error(
          `${chargingStation.logPrefix()} ${moduleName}.getChargingStationConnectorChargingProfilesPowerLimit: Charging profile id ${matchingChargingProfile?.chargingProfileId} limit ${limit} is greater than connector id ${connectorId} maximum ${connectorMaximumPower}: %j`,
          result,
        );
        limit = connectorMaximumPower;
      }
    }
  }
  return limit;
};

export const getDefaultVoltageOut = (
  currentType: CurrentType,
  logPrefix: string,
  templateFile: string,
): Voltage => {
  const errorMsg = `Unknown ${currentType} currentOutType in template file ${templateFile}, cannot define default voltage out`;
  let defaultVoltageOut: number;
  switch (currentType) {
    case CurrentType.AC:
      defaultVoltageOut = Voltage.VOLTAGE_230;
      break;
    case CurrentType.DC:
      defaultVoltageOut = Voltage.VOLTAGE_400;
      break;
    default:
      logger.error(`${logPrefix} ${errorMsg}`);
      throw new BaseError(errorMsg);
  }
  return defaultVoltageOut;
};

export const getIdTagsFile = (stationInfo: ChargingStationInfo): string | undefined => {
  return (
    stationInfo.idTagsFile &&
    join(dirname(fileURLToPath(import.meta.url)), 'assets', basename(stationInfo.idTagsFile))
  );
};

export const waitChargingStationEvents = async (
  emitter: EventEmitter,
  event: ChargingStationWorkerMessageEvents,
  eventsToWait: number,
): Promise<number> => {
  return new Promise<number>((resolve) => {
    let events = 0;
    if (eventsToWait === 0) {
      resolve(events);
    }
    emitter.on(event, () => {
      ++events;
      if (events === eventsToWait) {
        resolve(events);
      }
    });
  });
};

const getConfiguredNumberOfConnectors = (stationTemplate: ChargingStationTemplate): number => {
  let configuredMaxConnectors = 0;
  if (isNotEmptyArray(stationTemplate.numberOfConnectors) === true) {
    const numberOfConnectors = stationTemplate.numberOfConnectors as number[];
    configuredMaxConnectors =
      numberOfConnectors[Math.floor(secureRandom() * numberOfConnectors.length)];
  } else if (isUndefined(stationTemplate.numberOfConnectors) === false) {
    configuredMaxConnectors = stationTemplate.numberOfConnectors as number;
  } else if (stationTemplate.Connectors && !stationTemplate.Evses) {
    configuredMaxConnectors = stationTemplate.Connectors[0]
      ? getMaxNumberOfConnectors(stationTemplate.Connectors) - 1
      : getMaxNumberOfConnectors(stationTemplate.Connectors);
  } else if (stationTemplate.Evses && !stationTemplate.Connectors) {
    for (const evse in stationTemplate.Evses) {
      if (evse === '0') {
        continue;
      }
      configuredMaxConnectors += getMaxNumberOfConnectors(stationTemplate.Evses[evse].Connectors);
    }
  }
  return configuredMaxConnectors;
};

const checkConfiguredMaxConnectors = (
  configuredMaxConnectors: number,
  logPrefix: string,
  templateFile: string,
): void => {
  if (configuredMaxConnectors <= 0) {
    logger.warn(
      `${logPrefix} Charging station information from template ${templateFile} with ${configuredMaxConnectors} connectors`,
    );
  }
};

const checkTemplateMaxConnectors = (
  templateMaxConnectors: number,
  logPrefix: string,
  templateFile: string,
): void => {
  if (templateMaxConnectors === 0) {
    logger.warn(
      `${logPrefix} Charging station information from template ${templateFile} with empty connectors configuration`,
    );
  } else if (templateMaxConnectors < 0) {
    logger.error(
      `${logPrefix} Charging station information from template ${templateFile} with no connectors configuration defined`,
    );
  }
};

const initializeConnectorStatus = (connectorStatus: ConnectorStatus): void => {
  connectorStatus.availability = AvailabilityType.Operative;
  connectorStatus.idTagLocalAuthorized = false;
  connectorStatus.idTagAuthorized = false;
  connectorStatus.transactionRemoteStarted = false;
  connectorStatus.transactionStarted = false;
  connectorStatus.energyActiveImportRegisterValue = 0;
  connectorStatus.transactionEnergyActiveImportRegisterValue = 0;
  if (isUndefined(connectorStatus.chargingProfiles)) {
    connectorStatus.chargingProfiles = [];
  }
};

const warnDeprecatedTemplateKey = (
  template: ChargingStationTemplate,
  key: string,
  logPrefix: string,
  templateFile: string,
  logMsgToAppend = '',
): void => {
  if (!isUndefined(template[key as keyof ChargingStationTemplate])) {
    const logMsg = `Deprecated template key '${key}' usage in file '${templateFile}'${
      isNotEmptyString(logMsgToAppend) ? `. ${logMsgToAppend}` : ''
    }`;
    logger.warn(`${logPrefix} ${logMsg}`);
    console.warn(chalk.yellow(`${logMsg}`));
  }
};

const convertDeprecatedTemplateKey = (
  template: ChargingStationTemplate,
  deprecatedKey: string,
  key?: string,
): void => {
  if (!isUndefined(template[deprecatedKey as keyof ChargingStationTemplate])) {
    if (!isUndefined(key)) {
      (template as unknown as Record<string, unknown>)[key!] =
        template[deprecatedKey as keyof ChargingStationTemplate];
    }
    delete template[deprecatedKey as keyof ChargingStationTemplate];
  }
};

interface ChargingProfilesLimit {
  limit: number;
  matchingChargingProfile: ChargingProfile;
}

/**
 * Charging profiles shall already be sorted by connector id and stack level (highest stack level has priority)
 *
 * @param chargingStation -
 * @param connectorId -
 * @param chargingProfiles -
 * @param logPrefix -
 * @returns ChargingProfilesLimit
 */
const getLimitFromChargingProfiles = (
  chargingStation: ChargingStation,
  connectorId: number,
  chargingProfiles: ChargingProfile[],
  logPrefix: string,
): ChargingProfilesLimit | undefined => {
  const debugLogMsg = `${logPrefix} ${moduleName}.getLimitFromChargingProfiles: Matching charging profile found for power limitation: %j`;
  const currentDate = new Date();
  const connectorStatus = chargingStation.getConnectorStatus(connectorId);
  for (const chargingProfile of chargingProfiles) {
    const chargingSchedule = chargingProfile.chargingSchedule;
    if (connectorStatus?.transactionStarted && isNullOrUndefined(chargingSchedule?.startSchedule)) {
      logger.debug(
        `${logPrefix} ${moduleName}.getLimitFromChargingProfiles: Charging profile id ${chargingProfile.chargingProfileId} has no startSchedule defined. Trying to set it to the connector current transaction start date`,
      );
      // OCPP specifies that if startSchedule is not defined, it should be relative to start of the connector transaction
      chargingSchedule.startSchedule = connectorStatus?.transactionStart;
    }
    if (!isDate(chargingSchedule?.startSchedule)) {
      logger.warn(
        `${logPrefix} ${moduleName}.getLimitFromChargingProfiles: Charging profile id ${chargingProfile.chargingProfileId} startSchedule property is not a Date object. Trying to convert it to a Date object`,
      );
      chargingSchedule.startSchedule = convertToDate(chargingSchedule?.startSchedule)!;
    }
    switch (chargingProfile.chargingProfileKind) {
      case ChargingProfileKindType.RECURRING:
        if (!canProceedRecurringChargingProfile(chargingProfile, logPrefix)) {
          continue;
        }
        prepareRecurringChargingProfile(chargingProfile, currentDate, logPrefix);
        break;
      case ChargingProfileKindType.RELATIVE:
        connectorStatus?.transactionStarted &&
          (chargingSchedule.startSchedule = connectorStatus?.transactionStart);
        break;
    }
    if (!canProceedChargingProfile(chargingProfile, currentDate, logPrefix)) {
      continue;
    }
    // Check if the charging profile is active
    if (
      isValidTime(chargingSchedule?.startSchedule) &&
      isWithinInterval(currentDate, {
        start: chargingSchedule.startSchedule!,
        end: addSeconds(chargingSchedule.startSchedule!, chargingSchedule.duration!),
      })
    ) {
      if (isNotEmptyArray(chargingSchedule.chargingSchedulePeriod)) {
        const chargingSchedulePeriodCompareFn = (
          a: ChargingSchedulePeriod,
          b: ChargingSchedulePeriod,
        ) => a.startPeriod - b.startPeriod;
        if (
          isArraySorted<ChargingSchedulePeriod>(
            chargingSchedule.chargingSchedulePeriod,
            chargingSchedulePeriodCompareFn,
          ) === false
        ) {
          logger.warn(
            `${logPrefix} ${moduleName}.getLimitFromChargingProfiles: Charging profile id ${chargingProfile.chargingProfileId} schedule periods are not sorted by start period`,
          );
          chargingSchedule.chargingSchedulePeriod.sort(chargingSchedulePeriodCompareFn);
        }
        // Check if the first schedule period start period is equal to 0
        if (chargingSchedule.chargingSchedulePeriod[0].startPeriod !== 0) {
          logger.error(
            `${logPrefix} ${moduleName}.getLimitFromChargingProfiles: Charging profile id ${chargingProfile.chargingProfileId} first schedule period start period ${chargingSchedule.chargingSchedulePeriod[0].startPeriod} is not equal to 0`,
          );
          continue;
        }
        // Handle only one schedule period
        if (chargingSchedule.chargingSchedulePeriod.length === 1) {
          const result: ChargingProfilesLimit = {
            limit: chargingSchedule.chargingSchedulePeriod[0].limit,
            matchingChargingProfile: chargingProfile,
          };
          logger.debug(debugLogMsg, result);
          return result;
        }
        let previousChargingSchedulePeriod: ChargingSchedulePeriod | undefined;
        // Search for the right schedule period
        for (const [
          index,
          chargingSchedulePeriod,
        ] of chargingSchedule.chargingSchedulePeriod.entries()) {
          // Find the right schedule period
          if (
            isAfter(
              addSeconds(chargingSchedule.startSchedule!, chargingSchedulePeriod.startPeriod),
              currentDate,
            )
          ) {
            // Found the schedule period: previous is the correct one
            const result: ChargingProfilesLimit = {
              limit: previousChargingSchedulePeriod!.limit,
              matchingChargingProfile: chargingProfile,
            };
            logger.debug(debugLogMsg, result);
            return result;
          }
          // Keep a reference to previous one
          previousChargingSchedulePeriod = chargingSchedulePeriod;
          // Handle the last schedule period within the charging profile duration
          if (
            index === chargingSchedule.chargingSchedulePeriod.length - 1 ||
            (index < chargingSchedule.chargingSchedulePeriod.length - 1 &&
              chargingSchedule.duration! >
                differenceInSeconds(
                  addSeconds(
                    chargingSchedule.startSchedule!,
                    chargingSchedule.chargingSchedulePeriod[index + 1].startPeriod,
                  ),
                  chargingSchedule.startSchedule!,
                ))
          ) {
            const result: ChargingProfilesLimit = {
              limit: previousChargingSchedulePeriod.limit,
              matchingChargingProfile: chargingProfile,
            };
            logger.debug(debugLogMsg, result);
            return result;
          }
        }
      }
    }
  }
};

const canProceedChargingProfile = (
  chargingProfile: ChargingProfile,
  currentDate: Date,
  logPrefix: string,
): boolean => {
  if (
    (isValidTime(chargingProfile.validFrom) && isBefore(currentDate, chargingProfile.validFrom!)) ||
    (isValidTime(chargingProfile.validTo) && isAfter(currentDate, chargingProfile.validTo!))
  ) {
    logger.debug(
      `${logPrefix} ${moduleName}.canProceedChargingProfile: Charging profile id ${
        chargingProfile.chargingProfileId
      } is not valid for the current date ${currentDate.toISOString()}`,
    );
    return false;
  }
  const chargingSchedule = chargingProfile.chargingSchedule;
  if (isNullOrUndefined(chargingSchedule?.startSchedule)) {
    logger.error(
      `${logPrefix} ${moduleName}.canProceedChargingProfile: Charging profile id ${chargingProfile.chargingProfileId} has (still) no startSchedule defined`,
    );
    return false;
  }
  if (isNullOrUndefined(chargingSchedule?.duration)) {
    logger.error(
      `${logPrefix} ${moduleName}.canProceedChargingProfile: Charging profile id ${chargingProfile.chargingProfileId} has no duration defined, not yet supported`,
    );
    return false;
  }
  return true;
};

const canProceedRecurringChargingProfile = (
  chargingProfile: ChargingProfile,
  logPrefix: string,
): boolean => {
  if (
    chargingProfile.chargingProfileKind === ChargingProfileKindType.RECURRING &&
    isNullOrUndefined(chargingProfile.recurrencyKind)
  ) {
    logger.error(
      `${logPrefix} ${moduleName}.canProceedRecurringChargingProfile: Recurring charging profile id ${chargingProfile.chargingProfileId} has no recurrencyKind defined`,
    );
    return false;
  }
  return true;
};

/**
 * Adjust recurring charging profile startSchedule to the current recurrency time interval if needed
 *
 * @param chargingProfile -
 * @param currentDate -
 * @param logPrefix -
 */
const prepareRecurringChargingProfile = (
  chargingProfile: ChargingProfile,
  currentDate: Date,
  logPrefix: string,
): boolean => {
  const chargingSchedule = chargingProfile.chargingSchedule;
  let recurringIntervalTranslated = false;
  let recurringInterval: Interval;
  switch (chargingProfile.recurrencyKind) {
    case RecurrencyKindType.DAILY:
      recurringInterval = {
        start: chargingSchedule.startSchedule!,
        end: addDays(chargingSchedule.startSchedule!, 1),
      };
      checkRecurringChargingProfileDuration(chargingProfile, recurringInterval, logPrefix);
      if (
        !isWithinInterval(currentDate, recurringInterval) &&
        isBefore(recurringInterval.end, currentDate)
      ) {
        chargingSchedule.startSchedule = addDays(
          recurringInterval.start,
          differenceInDays(currentDate, recurringInterval.start),
        );
        recurringInterval = {
          start: chargingSchedule.startSchedule,
          end: addDays(chargingSchedule.startSchedule, 1),
        };
        recurringIntervalTranslated = true;
      }
      break;
    case RecurrencyKindType.WEEKLY:
      recurringInterval = {
        start: chargingSchedule.startSchedule!,
        end: addWeeks(chargingSchedule.startSchedule!, 1),
      };
      checkRecurringChargingProfileDuration(chargingProfile, recurringInterval, logPrefix);
      if (
        !isWithinInterval(currentDate, recurringInterval) &&
        isBefore(recurringInterval.end, currentDate)
      ) {
        chargingSchedule.startSchedule = addWeeks(
          recurringInterval.start,
          differenceInWeeks(currentDate, recurringInterval.start),
        );
        recurringInterval = {
          start: chargingSchedule.startSchedule,
          end: addWeeks(chargingSchedule.startSchedule, 1),
        };
        recurringIntervalTranslated = true;
      }
      break;
    default:
      logger.error(
        `${logPrefix} ${moduleName}.prepareRecurringChargingProfile: Recurring charging profile id ${chargingProfile.chargingProfileId} recurrency kind ${chargingProfile.recurrencyKind} is not supported`,
      );
  }
  if (recurringIntervalTranslated && !isWithinInterval(currentDate, recurringInterval!)) {
    logger.error(
      `${logPrefix} ${moduleName}.prepareRecurringChargingProfile: Recurring ${
        chargingProfile.recurrencyKind
      } charging profile id ${chargingProfile.chargingProfileId} recurrency time interval [${toDate(
        recurringInterval!.start,
      ).toISOString()}, ${toDate(
        recurringInterval!.end,
      ).toISOString()}] has not been properly translated to current date ${currentDate.toISOString()} `,
    );
  }
  return recurringIntervalTranslated;
};

const checkRecurringChargingProfileDuration = (
  chargingProfile: ChargingProfile,
  interval: Interval,
  logPrefix: string,
): void => {
  if (isNullOrUndefined(chargingProfile.chargingSchedule.duration)) {
    logger.warn(
      `${logPrefix} ${moduleName}.checkRecurringChargingProfileDuration: Recurring ${
        chargingProfile.chargingProfileKind
      } charging profile id ${
        chargingProfile.chargingProfileId
      } duration is not defined, set it to the recurrency time interval duration ${differenceInSeconds(
        interval.end,
        interval.start,
      )}`,
    );
    chargingProfile.chargingSchedule.duration = differenceInSeconds(interval.end, interval.start);
  } else if (
    chargingProfile.chargingSchedule.duration! > differenceInSeconds(interval.end, interval.start)
  ) {
    logger.warn(
      `${logPrefix} ${moduleName}.checkRecurringChargingProfileDuration: Recurring ${
        chargingProfile.chargingProfileKind
      } charging profile id ${chargingProfile.chargingProfileId} duration ${
        chargingProfile.chargingSchedule.duration
      } is greater than the recurrency time interval duration ${differenceInSeconds(
        interval.end,
        interval.start,
      )}`,
    );
    chargingProfile.chargingSchedule.duration = differenceInSeconds(interval.end, interval.start);
  }
};

const getRandomSerialNumberSuffix = (params?: {
  randomBytesLength?: number;
  upperCase?: boolean;
}): string => {
  const randomSerialNumberSuffix = randomBytes(params?.randomBytesLength ?? 16).toString('hex');
  if (params?.upperCase) {
    return randomSerialNumberSuffix.toUpperCase();
  }
  return randomSerialNumberSuffix;
};