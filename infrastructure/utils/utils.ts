import { Architecture } from "aws-cdk-lib/aws-lambda"


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