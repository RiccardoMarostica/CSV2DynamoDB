import { Duration } from "aws-cdk-lib";
import { Architecture } from "aws-cdk-lib/aws-lambda"

/**
 * @description Returns the Lambda architecture to apply
 * @param arch Input architecture to validate
 * @returns Architecture type: X86_64, ARM64
 */
export const getLambdaArchitecture = (arch?: string): Architecture => {
    if (!arch) {
        // By default, return the X86_64 arch
        return Architecture.X86_64;
    } else {
        if (arch == "X86_64") {
            // User want X86_64 arch
            return Architecture.X86_64;
        }
        if (arch == "ARM64") {
            // User wants ARM64 arch
            return Architecture.ARM_64;
        }
        // In case of invalid string, then return default arch (X86_64)
        return Architecture.X86_64;
    }
}

/**
 * @description Returns the duration in seconds for the current input
 * @param time Input time to set in seconds
 * @returns Duration in seconds
 */
export const getDurationInSeconds = (time: number): Duration => {
    return Duration.seconds(time ?? 60);
}

/**
 * @description Returns the duration in days for the current input
 * @param time Input time to set in days
 * @returns Duration in days
 */
export const getDurationInDays = (days: number): Duration => {
    return Duration.days(days ?? 7);
}