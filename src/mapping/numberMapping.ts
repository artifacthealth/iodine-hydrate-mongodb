import {MappingBase} from "./mappingBase";
import {MappingModel} from "./mappingModel";
import {ReadContext} from "./readContext";
import {WriteContext} from "./writeContext";

/**
 * @hidden
 */
export class NumberMapping extends MappingBase {

    constructor() {
        super(MappingModel.MappingFlags.Number);
    }

    read(context: ReadContext, value: any): any {

        if(value == null) return null;

        if(typeof value !== "number") {
            context.addError("Expected number.");
            return;
        }
        return value;
    }

    write(context: WriteContext, value: any): any {

        if(value == null) return null;

        if(typeof value !== "number") {
            context.addError("Expected number.");
            return;
        }
        return value;
    }
}
